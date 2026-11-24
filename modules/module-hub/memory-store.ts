import type { HubInstall } from '../contribute/hub/store'
import type { HubModule, HubModuleRow, HubModuleRun, HubModuleVersion, ModuleHubStore } from './store'

const key = (installId: string, moduleId: string) => `${installId}/${moduleId}`

/**
 * In-memory ModuleHubStore (same semantics as the DB store). `installs` is the
 * contribute hub's install map (memoryHubStore().installs): the listing hides
 * the modules of revoked and unknown installs, like the DB store's join.
 */
export function memoryModuleHubStore(installs: Map<string, HubInstall>): ModuleHubStore & {
  versionsBySha: Map<string, HubModuleVersion>
  modules: Map<string, HubModule>
  runRows: Map<string, HubModuleRun>
} {
  const versionsBySha = new Map<string, HubModuleVersion>()
  const modules = new Map<string, HubModule>()
  const runRows = new Map<string, HubModuleRun>()
  const copy = <T>(v: T): T => structuredClone(v)
  const versionsOf = (installId: string, moduleId: string) =>
    [...versionsBySha.values()]
      .filter((v) => v.installId === installId && v.moduleId === moduleId)
      .sort((a, b) => b.publishedAt.getTime() - a.publishedAt.getTime() || (a.bundleSha256 < b.bundleSha256 ? 1 : -1))
  const row = (m: HubModule): HubModuleRow => {
    const latest = versionsBySha.get(m.latestBundleSha256)
    if (!latest) throw new Error(`module ${m.moduleId} has no latest version ${m.latestBundleSha256}`)
    return { ...copy(m), description: latest.manifest.description, latestVersion: latest.version, versions: versionsOf(m.installId, m.moduleId).length }
  }
  return {
    versionsBySha,
    modules,
    runRows,
    async getVersion(sha) {
      const v = versionsBySha.get(sha)
      return v ? copy(v) : null
    },
    async versionByCommit(installId, moduleId, commit) {
      const v = versionsOf(installId, moduleId).find((x) => x.commit === commit)
      return v ? copy(v) : null
    },
    async insertVersion(v) {
      if (versionsBySha.has(v.bundleSha256)) return false
      if (versionsOf(v.installId, v.moduleId).some((x) => x.commit === v.commit)) return false
      versionsBySha.set(v.bundleSha256, copy(v))
      const k = key(v.installId, v.moduleId)
      const old = modules.get(k)
      modules.set(k, {
        installId: v.installId,
        moduleId: v.moduleId,
        name: v.manifest.name,
        latestBundleSha256: v.bundleSha256,
        firstPublishedAt: old?.firstPublishedAt ?? v.publishedAt,
        lastPublishedAt: v.publishedAt,
      })
      return true
    },
    async setSummary(sha, summary, at) {
      const v = versionsBySha.get(sha)
      if (!v) throw new Error(`no module version ${sha}`)
      v.summary = copy(summary)
      v.summaryAt = at
    },
    async listModules({ query, offset, limit }) {
      const q = query?.trim().toLowerCase()
      return [...modules.values()]
        .filter((m) => {
          const i = installs.get(m.installId)
          return i !== undefined && i.revokedAt === null
        })
        .filter((m) => !q || m.moduleId.toLowerCase().includes(q) || m.name.toLowerCase().includes(q))
        .sort((a, b) => b.lastPublishedAt.getTime() - a.lastPublishedAt.getTime() || key(a.installId, a.moduleId).localeCompare(key(b.installId, b.moduleId)))
        .slice(offset, offset + limit)
        .map(row)
    },
    async getModule(installId, moduleId) {
      const m = modules.get(key(installId, moduleId))
      return m ? row(m) : null
    },
    async versions(installId, moduleId) {
      return versionsOf(installId, moduleId).map(copy)
    },
    async reportRun(run) {
      runRows.set(key(run.installId, run.moduleId), copy(run))
    },
    async runs(installId, moduleId) {
      return [...runRows.values()]
        .flatMap((r) => {
          const v = versionsBySha.get(r.bundleSha256)
          return v && v.installId === installId && v.moduleId === moduleId ? [{ ...copy(r), version: v.version }] : []
        })
        .sort((a, b) => b.reportedAt.getTime() - a.reportedAt.getTime())
    },
  }
}
