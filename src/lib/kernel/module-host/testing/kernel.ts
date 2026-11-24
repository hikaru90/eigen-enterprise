import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI } from '../../../../../contracts/fixtures/module-hub-test-key'
import { createAdminTools, kernelManifest, type AdminApprovalStore } from '../../admin-tools'
import {
  InMemoryApprovalModeStore,
  InMemoryApprovalStore,
  ModeAwareApprovalPolicy,
  type ApprovalMode,
} from '../../approvals'
import { InMemoryEventSink } from '../../events'
import { InMemoryActivationStore, ModuleRegistry } from '../../modules'
import { KernelRegistry } from '../../registry'
import { ModuleHost, type ModuleHostLimits } from '../host'
import {
  InMemoryCursorStore,
  InMemoryDataRepo,
  InMemoryModulePrincipals,
  InMemoryModuleStore,
  inMemoryEventFeed,
} from '../memory'
import type { ModuleBundles, ModuleRecord, ModuleWorkloadPort, PublishedVersion } from '../types'
import { FakeModuleWorkload } from './fake-workload'

/**
 * TEST ONLY — an in-memory kernel with the module host wired (registry,
 * module registry, activations, approvals with a settable mode, the kernel
 * admin tools, the host's in-memory stores) and a temp `$EE_STATE_DIR`.
 */

export const OWNER = { id: 'owner-1', kind: 'human' as const, roles: ['owner', 'admin'] }
export const MEMBER = { id: 'member-1', kind: 'human' as const, roles: ['member'] }
export const AGENT = { id: 'agent-1', kind: 'agent' as const, roles: ['admin', 'agent'] }

export type TestHostKernel = Awaited<ReturnType<typeof testHostKernel>>

export async function testHostKernel(
  options: {
    limits?: Partial<ModuleHostLimits>
    workload?: (stateDir: string) => ModuleWorkloadPort
    mode?: ApprovalMode
    /** Where deploy bytes come from (default: the bundles `deploy` was given). */
    bundles?: ModuleBundles
  } = {},
) {
  // Short: a Unix socket path is at most ~104 bytes on macOS.
  const stateDir = await mkdtemp(join(tmpdir(), 'eh-'))
  const activations = new InMemoryActivationStore()
  const eventSink = new InMemoryEventSink()
  const approvals = new InMemoryApprovalStore()
  const approvalMode = new InMemoryApprovalModeStore(options.mode ?? 'allow_all')
  const registry = new KernelRegistry({
    eventSink,
    activationStore: activations,
    approvalStore: approvals,
    approvalPolicy: new ModeAwareApprovalPolicy(new Set(['kernel.module_deactivate']), approvalMode),
  })
  const modules = new ModuleRegistry(activations)
  modules.register(kernelManifest)
  await activations.set('kernel', true)
  const listable = Object.assign(approvals, {
    list: async () => approvals.listPending(),
  }) as unknown as AdminApprovalStore
  for (const tool of createAdminTools({ modules, activations, approvals: listable, tool: (n) => registry.get(n) })) {
    registry.register(tool)
  }
  const store = new InMemoryModuleStore()
  const principals = new InMemoryModulePrincipals()
  const cursors = new InMemoryCursorStore()
  const data = new InMemoryDataRepo()
  const bundles = new Map<string, Uint8Array>()
  const workload =
    options.workload?.(stateDir) ??
    new FakeModuleWorkload({ stateDir, trustedKeys: [TEST_ONLY_MODULE_HUB_PUBLIC_KEY_SPKI] })
  const people = new Map<string, { id: string; roles: string[] }>([
    [OWNER.id, { id: OWNER.id, roles: OWNER.roles }],
    [MEMBER.id, { id: MEMBER.id, roles: MEMBER.roles }],
  ])
  const pins: { id: string; entry: unknown; by: string }[] = []
  const runReports: { moduleId: string; bundleSha256: string; state: string }[] = []
  const host = new ModuleHost({
    registry,
    modules,
    activations,
    eventSink,
    store,
    principals,
    cursors,
    feed: inMemoryEventFeed(eventSink.events),
    data,
    workload,
    bundles: options.bundles ?? {
      bytes: async (id, commit) => {
        const b = bundles.get(`${id}@${commit}`)
        if (!b) throw new Error(`no test bundle for ${id}@${commit}`)
        return b
      },
    },
    people: { personById: async (id) => people.get(id) ?? null },
    stateDir: () => stateDir,
    system: { pin: async (id, entry, by) => void pins.push({ id, entry, by }) },
    runReport: async (r) => void runReports.push(r),
    limits: { watchdogMs: 60_000, deliveryPollMs: 60_000, ...options.limits },
    log: () => undefined,
  })
  await host.start()

  /** A scaffolded record (state unpublished) owned by OWNER. */
  const scaffold = async (id: string, owner = OWNER.id): Promise<void> => {
    const record: ModuleRecord = {
      id,
      ownerUserId: owner,
      manifest: null,
      receipt: null,
      commit: null,
      bundleSha256: null,
      state: 'unpublished',
      reason: null,
      stateSince: new Date().toISOString(),
      firstDeployedAt: null,
      deployedFrom: null,
      deployedBy: null,
      pendingDeploy: null,
    }
    await store.create(record)
  }

  /** Publishes (records the version and its bytes) and deploys it. */
  const deploy = async (published: { version: PublishedVersion; bytes: Uint8Array }, by = OWNER.id) => {
    bundles.set(`${published.version.moduleId}@${published.version.commit}`, published.bytes)
    if (!(await store.version(published.version.moduleId, published.version.commit))) {
      await store.addVersion(published.version)
    }
    return host.deploy(published.version, by)
  }

  const cleanup = async () => {
    await host.stop()
    if (workload instanceof FakeModuleWorkload) await workload.shutdown()
    await rm(stateDir, { recursive: true, force: true })
  }

  return {
    runReports,
    stateDir,
    registry,
    modules,
    activations,
    eventSink,
    approvals,
    store,
    principals,
    cursors,
    data,
    workload,
    host,
    pins,
    bundles,
    scaffold,
    deploy,
    cleanup,
    setMode: (m: ApprovalMode) => approvalMode.set(m, 'test'),
  }
}

/**
 * A workload port that runs nothing: it records each verb and answers with a
 * view (specs where the module side is a raw eem/1 client in the spec itself).
 */
export function recordingWorkload(overrides: Partial<ModuleWorkloadPort> = {}) {
  const calls: { verb: string; id: string; body?: unknown }[] = []
  const views = new Map<string, import('../../../../../contracts/module-workload').ModuleView>()
  const view = (id: string, commit: string, sha: string, state: 'running' | 'stopped') => ({
    id,
    workload: `mod-${id}`,
    version: '0.1.0',
    commit,
    bundleSha256: sha,
    desired: state,
    stopReason: null,
    state,
    error: null,
    restarts: 0,
    since: new Date().toISOString(),
    releases: [{ commit, bundleSha256: sha }],
  })
  const port: ModuleWorkloadPort = {
    deploy: async (r) => {
      calls.push({ verb: 'deploy', id: r.id, body: r })
      const v = view(r.id, r.commit, r.sha256, 'running')
      views.set(r.id, v)
      return v
    },
    dryRun: async (r) => {
      calls.push({ verb: 'dryRun', id: r.id })
      return { passed: true, log: 'ok' }
    },
    list: async () => [...views.values()],
    get: async (id) => views.get(id) ?? null,
    stop: async (id, body) => {
      calls.push({ verb: 'stop', id, body })
      const v = { ...views.get(id)!, state: 'stopped' as const, desired: 'stopped' as const }
      views.set(id, v)
      return v
    },
    start: async (id, body) => {
      calls.push({ verb: 'start', id, body })
      const v = { ...views.get(id)!, state: 'running' as const, desired: 'running' as const }
      views.set(id, v)
      return v
    },
    logs: async () => ['a log line'],
    remove: async (id, body) => {
      calls.push({ verb: 'remove', id, body })
      const v = views.get(id)!
      views.delete(id)
      return v
    },
    ...overrides,
  }
  return Object.assign(port, { calls, views })
}

/** Polls `check` every 20 ms until it holds (or fails after `ms`). */
export async function until(check: () => boolean | Promise<boolean>, ms = 5_000, what = 'the condition'): Promise<void> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await check()) return
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`timed out after ${ms} ms waiting for ${what}`)
}
