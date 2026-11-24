import type { ModuleReceiptV1 } from '../../contracts/module-receipt'
import type { ModuleRunState } from '../../contracts/module-workload'

/**
 * The module hub's vocabulary as the owner (and the owner's agent) reads it
 * (plan/phase-upgrades-u2.md §7). Pure — no server imports — so the
 * Contribute → Modules page shares it.
 */

/** What the LLM wrote about one published version: new text, no decision. */
export type ModuleSummaryDto = {
  /** What the module does, for a person. */
  does: string
  /** What it reads and changes in the company (the core tools and events it uses). */
  touches: string
  /** What leaves the company through it (mail, messages, anything external). */
  sendsOut: string
}

export type HubModuleListItem = {
  installId: string
  moduleId: string
  name: string
  description: string
  latestVersion: string
  latestBundleSha256: string
  versions: number
  firstPublishedAt: string
  lastPublishedAt: string
}

export type HubFileDto = { path: string; size: number; mode: number }

export type HubVersionListItem = {
  bundleSha256: string
  version: string
  commit: string
  publishedAt: string
  summary: ModuleSummaryDto | null
}

export type HubRunDto = {
  installId: string
  bundleSha256: string
  version: string
  state: ModuleRunState
  reportedAt: string
}

export type HubModuleDetail = {
  module: HubModuleListItem
  /** Newest first. */
  versions: HubVersionListItem[]
  /** The installs running (or having reported) any version of it. */
  runs: HubRunDto[]
}

export type HubVersionDetail = {
  installId: string
  moduleId: string
  bundleSha256: string
  version: string
  commit: string
  coreApi: string
  /** The receipted module.yaml (canonical JSON form). */
  manifest: Record<string, unknown>
  uses: Record<string, unknown>
  provides: Record<string, unknown>
  permissions: Record<string, unknown>
  deprecatedUses: string[]
  bytes: number
  files: number
  receipt: ModuleReceiptV1
  publishedAt: string
  summary: ModuleSummaryDto | null
  summaryAt: string | null
}

export type HubFileContent =
  | { path: string; size: number; binary: false; content: string; truncated: boolean }
  | { path: string; size: number; binary: true }
