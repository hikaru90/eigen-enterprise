import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { DbHandle } from '$lib/kernel/db-stores'
import { KernelError } from '$lib/kernel/errors'
import type { EventSink } from '$lib/kernel/events'
import {
  DbCursorStore,
  DbModulePrincipals,
  DbModuleStore,
  DbSharingStore,
  dbEventFeed,
} from '$lib/kernel/module-host/db-stores'
import { ModuleHost } from '$lib/kernel/module-host/host'
import type { ModuleDataRepo, SystemPinPort } from '$lib/kernel/module-host/types'
import { isCompanyModuleName } from '$lib/kernel/manifest-schema'
import type { ActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import type { KernelRegistry } from '$lib/kernel/registry'
import { moduleBundles } from './bundles'
import { eeModuleWorkload, NO_EE_SENTENCE } from './ee-workload'
import type { PublishPort } from './ports'
import { MODULE_REPO_DIR, ModuleRepo } from './repo'
import { CompanyModules } from './service'

/**
 * The live wiring of the company's own modules (plan/phase-upgrades-u2.md §4,
 * §8): the module host over the kernel tables, ee's module verbs, the company
 * data repo (`extensions/<id>/`, system.yaml) and the module repo at
 * `$EE_STATE_DIR/module-repo/`. Built lazily, so composing the kernel touches
 * no database, no socket and no disk; started from the app boot.
 */

/** `$EE_STATE_DIR`, or the plan's sentence: modules run only on a box ee manages. */
export function moduleStateDir(env: Record<string, string | undefined> = process.env): string {
  const dir = env.EE_STATE_DIR?.trim()
  if (!dir) throw new KernelError('not_configured', `${NO_EE_SENTENCE}: EE_STATE_DIR is not set`)
  return dir
}

let publishPort: PublishPort | null = null

/**
 * The box's publish client (stream C, modules/company-modules/publish/) is
 * handed in by the composition root. Until it is, publishing fails loud.
 */
export function providePublishPort(port: PublishPort): void {
  publishPort = port
}

const notWired = () =>
  new KernelError(
    'hub_unavailable',
    "module hub not configured: this box's publish client is not wired, so new module code can't run yet. Everything already running keeps running.",
  )
const unwiredPublish: PublishPort = {
  publish: async () => Promise.reject(notWired()),
  fetchBundle: async () => Promise.reject(notWired()),
}

/** The company data repo as `data.*` and system.yaml write it (the live GitEngine). */
async function liveData(): Promise<{ data: ModuleDataRepo; system: SystemPinPort }> {
  const [{ companyData, liveAuthor }, { pinSystemModule, SYSTEM_PATH }] = await Promise.all([
    import('$lib/server/gitstore/live'),
    import('$lib/server/gitstore/system'),
  ])
  const engine = (await companyData()).framework.engine
  const data: ModuleDataRepo = {
    read: (path) => engine.readWorking(path),
    async list(prefix) {
      const out = []
      for (const path of await engine.listWorking(prefix)) {
        const s = await stat(join(engine.dir, path)).catch(() => null)
        if (s?.isFile()) out.push({ path, size: s.size })
      }
      return out
    },
    async write(changes, meta) {
      const { committed } = await engine.stage(
        'extensions',
        changes.map((c) => ({ path: c.path, content: c.bytes })),
        { author: await liveAuthor(meta.authorId), message: meta.message },
      )
      await committed
    },
  }
  const system: SystemPinPort = {
    async pin(id, entry, authorId) {
      const current = await engine.readWorking(SYSTEM_PATH)
      const next = pinSystemModule(current ? Buffer.from(current).toString('utf8') : null, id, entry)
      const { committed } = await engine.stage('system', [{ path: SYSTEM_PATH, content: next }], {
        author: await liveAuthor(authorId),
        message: entry ? `system: ${id} ${entry.version} (${entry.commit.slice(0, 12)})` : `system: removed ${id}`,
      })
      await committed
    },
  }
  return { data, system }
}

export type CompanyModulesKernel = {
  registry: KernelRegistry
  modules: ModuleRegistry
  activations: ActivationStore
  eventSink: EventSink
  db: DbHandle
}

export type LiveCompanyModules = {
  host(): Promise<ModuleHost>
  service(): Promise<CompanyModules>
}

const byRegistry = new WeakMap<KernelRegistry, LiveCompanyModules>()

export function liveCompanyModules(kernel: CompanyModulesKernel): LiveCompanyModules {
  let built: Promise<{ host: ModuleHost; service: CompanyModules }> | null = null
  const build = async () => {
    const stateDir = moduleStateDir()
    const repo = new ModuleRepo(join(stateDir, MODULE_REPO_DIR))
    const { data, system } = await liveData()
    const [{ liveAuthor }, { personFor, getUserRole }] = await Promise.all([
      import('$lib/server/gitstore/live'),
      import('$lib/server/auth/user-role'),
    ])
    const store = new DbModuleStore(kernel.db)
    const workload = eeModuleWorkload()
    const hub: PublishPort = {
      publish: (r) => (publishPort ?? unwiredPublish).publish(r),
      fetchBundle: (sha) => (publishPort ?? unwiredPublish).fetchBundle(sha),
    }
    const host = new ModuleHost({
      registry: kernel.registry,
      modules: kernel.modules,
      activations: kernel.activations,
      eventSink: kernel.eventSink,
      store,
      principals: new DbModulePrincipals(kernel.db),
      cursors: new DbCursorStore(kernel.db),
      feed: dbEventFeed(kernel.db),
      data,
      workload,
      bundles: moduleBundles(repo, store, hub),
      people: { personById: personFor },
      stateDir: () => stateDir,
      system,
    })
    const service = new CompanyModules({
      host,
      store,
      sharing: new DbSharingStore(kernel.db),
      repo,
      publish: hub,
      workload,
      eventSink: kernel.eventSink,
      coreTools: () => kernel.registry.list().filter((t) => !isCompanyModuleName(t.module)).map((t) => t.name),
      authorOf: liveAuthor,
      isOwner: async (userId) => (await getUserRole(userId)) === 'owner',
    })
    return { host, service }
  }
  const once = () => {
    built ??= build().catch((err: unknown) => {
      built = null
      throw err
    })
    return built
  }
  const live: LiveCompanyModules = {
    host: async () => (await once()).host,
    service: async () => (await once()).service,
  }
  byRegistry.set(kernel.registry, live)
  return live
}

/**
 * Boot (src/lib/server/boot.ts): registers every deployed module's tools and
 * opens their sockets. A box without ee (no EE_STATE_DIR) has no modules to
 * run: the boot says so once and goes on; every modules.* call then answers
 * with the same sentence.
 */
export async function startCompanyModules(registry: KernelRegistry): Promise<void> {
  const live = byRegistry.get(registry)
  if (!live) throw new Error('company modules are not wired into this kernel (buildKernel registers them)')
  try {
    moduleStateDir()
  } catch (err) {
    console.warn(`[modules] not started: ${(err as Error).message}`)
    return
  }
  await (await live.host()).start()
}
