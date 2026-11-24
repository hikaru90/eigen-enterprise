import type { ModuleManifestV1 } from '../../../../contracts/module-manifest'
import type { ModuleReceiptV1 } from '../../../../contracts/module-receipt'
import type {
  DeployModuleRequest,
  DryRunAnswer,
  ModuleView,
} from '../../../../contracts/module-workload'
import type { KernelEvent } from '../events'
import type { PersonRef } from '../principals'

/**
 * The kernel's module host (plan/phase-upgrades-u2.md §4): the records it
 * keeps and the ports it is built from. The host does no IO of its own
 * beyond its sockets; storage, ee and the data repo are injected.
 */

/** §4.6: where a company module stands, as the kernel sees it. */
export const COMPANY_MODULE_STATES = [
  'unpublished',
  'publishing',
  'deploying',
  'connecting',
  'running',
  'failed',
  'off',
] as const
export type CompanyModuleState = (typeof COMPANY_MODULE_STATES)[number]

/** A deploy an agent asked for that needs an admin's own click (D13), until one deploys. */
export type PendingDeploy = { commit: string; by: string; at: string }

/** One row of `kernel_modules`. */
export type ModuleRecord = {
  /** The module's local id (`hello`); its kernel id is `x-hello`. */
  id: string
  /** The box-side owner (D4): the person who scaffolded it; a background call acts as them. */
  ownerUserId: string
  /** The deployed manifest (null until the first deploy). */
  manifest: ModuleManifestV1 | null
  /** The receipt of the deployed commit (null until the first deploy). */
  receipt: ModuleReceiptV1 | null
  /** The deployed commit (null until the first deploy). While off, the commit a later switch-on starts. */
  commit: string | null
  bundleSha256: string | null
  state: CompanyModuleState
  /** Why it is failed or off, as a sentence a person reads; null otherwise. */
  reason: string | null
  stateSince: string
  firstDeployedAt: string | null
  /** The state before the current deploy began (a deploy out of `failed` ends in `module.recovered`). */
  deployedFrom: CompanyModuleState | null
  /** Who started the current deploy or switch-on (system.yaml is authored by them once it runs). */
  deployedBy: string | null
  pendingDeploy: PendingDeploy | null
}

/** The bytes of a module's bundle at a commit (rebuilt from the module repo; deterministic, §6.1). */
export type ModuleBundles = { bytes(id: string, commit: string): Promise<Uint8Array> }

/** A receipted (published) commit of a module. */
export type PublishedVersion = {
  moduleId: string
  commit: string
  version: string
  bundleSha256: string
  manifest: ModuleManifestV1
  receipt: ModuleReceiptV1
  publishedAt: string
}

export type ModuleStore = {
  get(id: string): Promise<ModuleRecord | null>
  list(): Promise<ModuleRecord[]>
  /** Inserts the record; fails loud when the id exists. */
  create(record: ModuleRecord): Promise<void>
  /** Replaces the whole record. */
  put(record: ModuleRecord): Promise<void>
  remove(id: string): Promise<void>
  /** The published versions, newest first. */
  versions(id: string): Promise<PublishedVersion[]>
  version(id: string, commit: string): Promise<PublishedVersion | null>
  addVersion(version: PublishedVersion): Promise<void>
}

/** §6.6: the owner's one-time OK that modules built here are open source and shared. */
export type SharingAcceptance = { by: string; at: string }
export type SharingStore = {
  get(): Promise<SharingAcceptance | null>
  accept(by: string): Promise<SharingAcceptance>
}

/** The module principal `module:<id>` (kind service, roles []) and its token hash (§4.2). */
export type ModulePrincipalStore = {
  setTokenHash(moduleId: string, tokenHash: string): Promise<void>
  tokenHash(moduleId: string): Promise<string | null>
}

/** Where a module's event delivery stands (`kernel_module_event_cursor`, §4.4). */
export type EventCursor = {
  moduleId: string
  /** The last event delivered and acked (or dropped); null = nothing yet since `startedAt`. */
  lastTs: string | null
  lastId: string | null
  /** Events older than this are never delivered (the module's first deploy). */
  startedAt: string
  /** The head event's failed attempts so far. */
  attempts: number
  /** When the head event failed first; after 24 h it is dropped. */
  failingSince: string | null
  nextAttemptAt: string | null
}
export type EventCursorStore = {
  get(moduleId: string): Promise<EventCursor | null>
  put(cursor: EventCursor): Promise<void>
  remove(moduleId: string): Promise<void>
}

/** The events after a cursor, in order (ts, then id), of the given types only. */
export type EventFeed = {
  after(
    position: { startedAt: string; lastTs: string | null; lastId: string | null },
    types: readonly string[],
    limit: number,
  ): Promise<KernelEvent[]>
}

/** One file of a module's data in the company data repo (`extensions/<id>/…`). */
export type DataFile = { path: string; bytes: Uint8Array }
/** The company data repo as `data.*` sees it (§4.3): paths are repo paths, writes are commits. */
export type ModuleDataRepo = {
  read(path: string): Promise<Uint8Array | null>
  /** Every file under `prefix` (a repo path ending in "/"), sorted, with sizes. */
  list(prefix: string): Promise<{ path: string; size: number }[]>
  /** Writes (bytes) or deletes (null) and commits as `author`. */
  write(
    changes: { path: string; bytes: Uint8Array | null }[],
    meta: { authorId: string; message: string },
  ): Promise<void>
}

/** The ee module verbs (contracts/module-workload.ts §5) the kernel calls. */
export type ModuleWorkloadPort = {
  deploy(request: DeployModuleRequest & { dryRun?: false }): Promise<ModuleView>
  dryRun(request: DeployModuleRequest & { dryRun: true }): Promise<DryRunAnswer>
  list(): Promise<ModuleView[]>
  /** null when ee doesn't know the module. */
  get(id: string): Promise<ModuleView | null>
  stop(id: string, body: { author: string; reason: 'person' | 'failed'; sentence: string }): Promise<ModuleView>
  start(id: string, body: { author: string }): Promise<ModuleView>
  logs(id: string, lines: number): Promise<string[]>
  remove(id: string, body: { author: string }): Promise<ModuleView>
}

/** Looks up a member as a person a module may act as in the background (its owner). */
export type ModulePeople = { personById(id: string): Promise<PersonRef | null> }

/** One `system.yaml` modules entry (v2, §3). */
export type SystemModulePin = { id: string; version: string; commit: string; bundleSha256: string }
/** Writes `system.yaml` in the data repo: one module pinned (or unpinned with null), authored by `authorId`. */
export type SystemPinPort = {
  pin(id: string, entry: SystemModulePin | null, authorId: string): Promise<void>
}
