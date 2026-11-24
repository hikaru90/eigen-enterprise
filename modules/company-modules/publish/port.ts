import type { ModuleReceiptV1 } from '../../../contracts/module-receipt'
import type { ModuleRunState } from '../../../contracts/module-workload'
import type { HubProblem, HubRunAnswer } from '../../../src/lib/module-hub/contract'

/**
 * The box's hands on the module hub (plan/phase-upgrades-u2.md §6, §8): what
 * `modules.publish` / `modules.test` / `modules.deploy` and a restore need.
 * Stream A's company-modules service depends on this port only; stream C
 * implements it (./client.ts over the signed hub API, ./live.ts wiring).
 *
 * Every failure is a PublishPortError with a code a tool maps 1:1 to its
 * KernelError and a sentence a person can read — no bypass, no retry loop.
 */

export type PublishRequest = {
  moduleId: string
  version: string
  /** The module-repo commit (40 hex). */
  commit: string
  /** The parsed module.yaml at that commit, as JSON. */
  manifest: Record<string, unknown>
  /** The deterministic bundle of `<id>/` at `commit` (contracts/module-bundle.ts). */
  bundle: Uint8Array
  bundleSha256: string
}

export type PublishOutcome = {
  receipt: ModuleReceiptV1
  /** true = a new receipt (201); false = the hub already had this bundle from this install (200, the same receipt). */
  created: boolean
}

export type RunReport = { moduleId: string; bundleSha256: string; state: ModuleRunState }

export type PublishPort = {
  /** Publishes a bundle and returns the hub's receipt (checked against what was sent). */
  publish(req: PublishRequest): Promise<PublishOutcome>
  /** Reports the run state of the release this box runs; answers which installs run the module. */
  reportRun(report: RunReport): Promise<HubRunAnswer>
  /** The bytes of a published bundle by sha256 (checked), for a restore. */
  fetchBundle(bundleSha256: string): Promise<Uint8Array>
}

/**
 * hub_unavailable — the hub can't be reached, is not configured, or is busy;
 * hub_refused     — the hub answered and refused (problems name the checks);
 * hub_revoked     — the hub refuses this install (403);
 * hub_not_found   — the hub has no such bundle (404).
 */
export type PublishPortErrorCode = 'hub_unavailable' | 'hub_refused' | 'hub_revoked' | 'hub_not_found'

/** §6.5, word for word. */
export const HUB_UNAVAILABLE_SENTENCE =
  "The module hub can't be reached, so new module code can't run yet. Everything already running keeps running."

/** §6.5: MODULE_HUB_URL unset. */
export const HUB_NOT_CONFIGURED_SENTENCE =
  "Module hub not configured on this server (MODULE_HUB_URL is not set), so new module code can't run yet. Everything already running keeps running."

export class PublishPortError extends Error {
  readonly code: PublishPortErrorCode
  /** The hub's HTTP status, or null when it gave no answer. */
  readonly status: number | null
  /** Every problem the hub named (409 / 413 / 422); empty otherwise. */
  readonly problems: HubProblem[]
  /** Why the hub is unavailable, for hub_unavailable. */
  readonly reason: 'not_configured' | 'unreachable' | 'busy' | null
  constructor(
    code: PublishPortErrorCode,
    message: string,
    opts: { status?: number | null; problems?: HubProblem[]; reason?: PublishPortError['reason'] } = {},
  ) {
    super(message)
    this.name = 'PublishPortError'
    this.code = code
    this.status = opts.status ?? null
    this.problems = opts.problems ?? []
    this.reason = opts.reason ?? null
  }
}
