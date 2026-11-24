import { CORE_API_VERSION } from '../../contracts/core-api-version'
import { kernelModuleId, manifestCatalogGaps, satisfiesCoreApi } from '../../contracts/module-manifest'
import { KernelError } from '$lib/kernel/errors'
import { CORE_EVENTS } from '$lib/kernel/event-catalog'
import { emitKernelEvent, type EventSink } from '$lib/kernel/events'
import { CORE_UI_SLOTS } from '$lib/kernel/ui-slots'
import { moduleSource } from '$lib/kernel/cloudevents'
import type { ModuleHost, ModuleSessionView } from '$lib/kernel/module-host/host'
import type {
  ModuleRecord,
  ModuleStore,
  ModuleWorkloadPort,
  PublishedVersion,
  SharingAcceptance,
  SharingStore,
} from '$lib/kernel/module-host/types'
import { isDirectHuman } from '$lib/kernel/principals'
import type { ToolPrincipal } from '$lib/kernel/types'
import type { GitAuthor } from '$lib/server/gitstore/engine'
import type { ModuleView } from '../../contracts/module-workload'
import { hubKernelError, type PublishPort } from './ports'
import type { ModuleRepo, TreeEntry } from './repo'
import { scaffoldFiles, type ScaffoldInput } from './scaffold'
import { wideningOf } from './widening'

/**
 * The box's Modules module (plan/phase-upgrades-u2.md §8): scaffold, write,
 * commit, publish, test, deploy and remove the company's own modules. Every
 * entry point is a `modules.*` registry tool (tools.ts); Settings → Modules is
 * a client of those. The module host (src/lib/kernel/module-host) runs them.
 */

export type CompanyModulesRuntime = {
  host: ModuleHost
  store: ModuleStore
  sharing: SharingStore
  repo: ModuleRepo
  publish: PublishPort
  workload: ModuleWorkloadPort
  eventSink: EventSink
  /** The registry's core tool names (what `uses.tools` may name on this box). */
  coreTools: () => Iterable<string>
  /** A person's name and email as a commit author. */
  authorOf: (principalId: string) => Promise<GitAuthor>
  /** Whether this member is the company's owner (the one-time sharing OK is theirs, §6.6). */
  isOwner: (userId: string) => Promise<boolean>
}

export type ModuleListItem = {
  id: string
  kernelModuleId: string
  name: string
  version: string | null
  state: ModuleRecord['state']
  sentence: string | null
  owner: string
  commit: string | null
  pendingDeploy: ModuleRecord['pendingDeploy']
}

const short = (commit: string) => commit.slice(0, 12)

function item(r: ModuleRecord): ModuleListItem {
  return {
    id: r.id,
    kernelModuleId: kernelModuleId(r.id),
    name: r.manifest?.name ?? r.id,
    version: r.manifest?.version ?? null,
    state: r.state,
    sentence: r.reason,
    owner: r.ownerUserId,
    commit: r.commit,
    pendingDeploy: r.pendingDeploy,
  }
}

const isAdminPerson = (p: ToolPrincipal) => isDirectHuman(p) && p.roles.includes('admin')

export class CompanyModules {
  constructor(private readonly rt: CompanyModulesRuntime) {}

  async list(): Promise<{ modules: ModuleListItem[]; sharing: SharingAcceptance | null }> {
    return { modules: (await this.rt.store.list()).map(item), sharing: await this.rt.sharing.get() }
  }

  async get(id: string) {
    const r = await this.record(id)
    const versions = await this.rt.store.versions(id)
    return {
      ...item(r),
      manifest: r.manifest,
      receipt: r.receipt,
      hub: r.receipt?.hub ?? null,
      firstDeployedAt: r.firstDeployedAt,
      stateSince: r.stateSince,
      lastCommit: await this.rt.repo.lastCommit(id),
      published: versions.map((v) => ({ commit: v.commit, version: v.version, bundleSha256: v.bundleSha256, publishedAt: v.publishedAt })),
    }
  }

  async status(id: string): Promise<{ kernel: ModuleListItem; session: ModuleSessionView; ee: ModuleView | null }> {
    const r = await this.record(id)
    return { kernel: item(r), session: this.rt.host.session(id), ee: r.commit ? await this.rt.workload.get(id) : null }
  }

  async logs(id: string, lines: number): Promise<{ lines: string[] }> {
    const r = await this.record(id)
    if (!r.commit) return { lines: [] }
    return { lines: await this.rt.workload.logs(id, lines) }
  }

  async source(
    id: string,
    commit: string | undefined,
    path: string | undefined,
  ): Promise<{ commit: string | null; tree: TreeEntry[] } | { commit: string | null; path: string; content: string }> {
    await this.record(id)
    const at = commit ?? null
    if (path === undefined) return { commit: at, tree: await this.rt.repo.tree(id, at) }
    return { commit: at, path, content: await this.rt.repo.read(id, path, at) }
  }

  async scaffold(by: ToolPrincipal, input: ScaffoldInput): Promise<{ id: string; commit: string; files: string[] }> {
    const files = scaffoldFiles(input)
    if ((await this.rt.store.get(input.id)) || (await this.rt.repo.exists(input.id))) {
      throw new KernelError('invalid_input', `a module "${input.id}" exists already`, { module: input.id })
    }
    for (const f of files) await this.rt.repo.writeFile(input.id, f.path, f.content)
    const { commit } = await this.rt.repo.commit(input.id, `Scaffold ${input.name}`, await this.rt.authorOf(by.id))
    await this.rt.store.create({
      id: input.id,
      ownerUserId: by.id,
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
    })
    return { id: input.id, commit, files: files.map((f) => f.path) }
  }

  async writeFile(id: string, path: string, content: string): Promise<{ id: string; path: string }> {
    await this.record(id)
    await this.rt.repo.writeFile(id, path, content)
    return { id, path }
  }

  async deleteFile(id: string, path: string): Promise<{ id: string; path: string }> {
    await this.record(id)
    await this.rt.repo.deleteFile(id, path)
    return { id, path }
  }

  async commit(by: ToolPrincipal, id: string, message: string): Promise<{ id: string; commit: string; changed: boolean }> {
    await this.record(id)
    return { id, ...(await this.rt.repo.commit(id, message, await this.rt.authorOf(by.id))) }
  }

  /** §6: publish before run. Needs the owner's one-time sharing OK; the same commit publishes once. */
  async publish(by: ToolPrincipal, id: string, commit: string): Promise<PublishedVersion> {
    const record = await this.record(id)
    if (!(await this.rt.sharing.get())) {
      throw new KernelError(
        'module_sharing_not_accepted',
        'Modules built here are open source (Apache-2.0) and shared with eigenEnterprise. The owner gives that OK once (Needs you, or Settings → Modules); until then nothing is published.',
        { module: id },
      )
    }
    const existing = await this.rt.store.version(id, commit)
    if (existing) return existing
    const manifest = await this.rt.repo.manifest(id, commit)
    if (!satisfiesCoreApi(manifest.requires['core-api'], CORE_API_VERSION)) {
      throw new KernelError(
        'invalid_input',
        `${manifest.name} requires core-api ${manifest.requires['core-api']}; this box runs ${CORE_API_VERSION}`,
        { module: id },
      )
    }
    const gaps = manifestCatalogGaps(manifest, {
      tools: this.rt.coreTools(),
      events: Object.keys(CORE_EVENTS),
      slots: CORE_UI_SLOTS.map((s) => s.name),
    })
    if (gaps.length > 0) {
      throw new KernelError('invalid_input', `${manifest.name} names what this box does not have: ${gaps.join(', ')}`, {
        module: id,
        gaps,
      })
    }
    const bundle = await this.rt.repo.bundle(id, commit)
    const publishing = record.state === 'unpublished'
    if (publishing) await this.rt.store.put({ ...record, state: 'publishing' })
    let receipt
    try {
      receipt = (
        await this.rt.publish.publish({
          moduleId: id,
          version: manifest.version,
          commit,
          manifest: manifest as unknown as Record<string, unknown>,
          bundle: bundle.bytes,
          bundleSha256: bundle.sha256,
        })
      ).receipt
    } catch (err) {
      throw hubKernelError(err, id)
    } finally {
      if (publishing) await this.rt.store.put({ ...(await this.record(id)), state: 'unpublished' })
    }
    if (receipt.moduleId !== id || receipt.commit !== commit || receipt.bundleSha256 !== bundle.sha256) {
      throw new KernelError('invalid_output', `the module hub's receipt pins another module, commit or bundle than ${id}@${short(commit)}`)
    }
    const version: PublishedVersion = {
      moduleId: id,
      commit,
      version: manifest.version,
      bundleSha256: bundle.sha256,
      manifest,
      receipt,
      publishedAt: receipt.issuedAt,
    }
    await this.rt.store.addVersion(version)
    await emitKernelEvent(this.rt.eventSink, {
      type: 'module.published',
      principalId: by.id,
      source: moduleSource(kernelModuleId(id)),
      payload: { module: id, name: manifest.name, version: manifest.version, commit, bundleSha256: bundle.sha256 },
    })
    return version
  }

  /** Publishes if needed, then ee builds and tests the bundle (nothing runs). */
  async test(by: ToolPrincipal, id: string, commit: string): Promise<{ commit: string; passed: boolean; log: string }> {
    const version = await this.publish(by, id, commit)
    return { commit, ...(await this.rt.host.dryRun(version, by.id)) }
  }

  /**
   * Deploys a published commit. A first deploy, or one that widens what the
   * module may reach, needs an admin's own click (D13): anyone else gets
   * `module_needs_admin_click`, and the admins a Needs you entry.
   */
  async deploy(by: ToolPrincipal, id: string, commit: string): Promise<ModuleListItem & { widens: string[] }> {
    const record = await this.record(id)
    const version = await this.rt.store.version(id, commit)
    if (!version) {
      throw new KernelError('module_unreceipted', `${id}@${short(commit)} is not published: publish it first (modules.publish)`, {
        module: id,
        commit,
      })
    }
    const deployed = record.commit ? await this.rt.store.version(id, record.commit) : null
    const widens = wideningOf(record.firstDeployedAt === null ? null : (deployed?.manifest ?? record.manifest), version.manifest)
    if (widens.length > 0 && !isAdminPerson(by)) {
      await this.rt.store.put({ ...record, pendingDeploy: { commit, by: by.id, at: new Date().toISOString() } })
      throw new KernelError(
        'module_needs_admin_click',
        `Deploying ${version.manifest.name}@${short(commit)} needs an admin's own click (${widens.join('; ')}). It is waiting in the admins' Needs you.`,
        { module: id, commit, widens },
      )
    }
    const after = await this.rt.host.deploy(version, by.id)
    return { ...item(after), widens }
  }

  async remove(by: ToolPrincipal, id: string): Promise<{ id: string; removed: true }> {
    if (!isAdminPerson(by)) {
      throw new KernelError('human_decision_required', 'Only an admin, at their own keyboard, removes a module.', { module: id })
    }
    await this.rt.host.remove(id, by.id)
    return { id, removed: true }
  }

  async acceptSharing(by: ToolPrincipal): Promise<SharingAcceptance> {
    if (!isDirectHuman(by) || !(await this.rt.isOwner(by.id))) {
      throw new KernelError('human_decision_required', 'Only the owner, at their own keyboard, gives the sharing OK.')
    }
    return this.rt.sharing.accept(by.id)
  }

  private async record(id: string): Promise<ModuleRecord> {
    const r = await this.rt.store.get(id)
    if (!r) throw new KernelError('unknown_module', `there is no company module "${id}"`, { module: id })
    return r
  }
}
