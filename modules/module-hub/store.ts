import type { ModuleManifestV1 } from '../../contracts/module-manifest'
import type { ModuleReceiptV1 } from '../../contracts/module-receipt'
import type { ModuleRunState } from '../../contracts/module-workload'
import type { HubFileDto, ModuleSummaryDto } from './types'

/** One published version (hub_module_versions, migration 0180). */
export type HubModuleVersion = {
  bundleSha256: string
  installId: string
  moduleId: string
  version: string
  commit: string
  manifest: ModuleManifestV1
  coreApi: string
  uses: ModuleManifestV1['uses']
  provides: ModuleManifestV1['provides']
  permissions: ModuleManifestV1['permissions']
  files: HubFileDto[]
  /** Packed bundle bytes. */
  bytes: number
  deprecatedUses: string[]
  receipt: ModuleReceiptV1
  publishedAt: Date
  summary: ModuleSummaryDto | null
  summaryAt: Date | null
}

/** One module of one install (hub_modules). */
export type HubModule = {
  installId: string
  moduleId: string
  name: string
  latestBundleSha256: string
  firstPublishedAt: Date
  lastPublishedAt: Date
}

/** A module row with its latest version's words, as the listing shows it. */
export type HubModuleRow = HubModule & { description: string; latestVersion: string; versions: number }

/** One install's run of one module (hub_module_runs: one slot per install and module id). */
export type HubModuleRun = {
  installId: string
  moduleId: string
  bundleSha256: string
  state: ModuleRunState
  reportedAt: Date
}

/** Persistence seam: the DB store in production, the in-memory one in unit tests and the mock hub. */
export type ModuleHubStore = {
  getVersion(bundleSha256: string): Promise<HubModuleVersion | null>
  versionByCommit(installId: string, moduleId: string, commit: string): Promise<HubModuleVersion | null>
  /**
   * Stores a new version and makes it its module's latest (the module row is
   * created on the first). false = the bundle sha or the install/module/commit
   * already exists (a concurrent publish): nothing is written.
   */
  insertVersion(v: HubModuleVersion): Promise<boolean>
  setSummary(bundleSha256: string, summary: ModuleSummaryDto, at: Date): Promise<void>
  /**
   * Modules of installs that are registered and not revoked, most recently
   * published first; `query` matches the module id or name (case-insensitive substring).
   */
  listModules(opts: { query?: string; offset: number; limit: number }): Promise<HubModuleRow[]>
  getModule(installId: string, moduleId: string): Promise<HubModuleRow | null>
  /** Newest first. */
  versions(installId: string, moduleId: string): Promise<HubModuleVersion[]>
  /** Upserts the reporting install's slot for this module id. */
  reportRun(run: HubModuleRun): Promise<void>
  /** Every install's run of any version of the module (installId, moduleId) published, most recent first. */
  runs(installId: string, moduleId: string): Promise<(HubModuleRun & { version: string })[]>
}
