/**
 * Persistence seam for sharing with the central board (migration 0136):
 * the single settings row and the outbox (one row per shared proposal). The
 * DB store in production, the in-memory one in unit tests.
 *
 * Outbox states: pending (to scrub) → scrubbed (to send) → sent; failed (a
 * refusal that is not retried); excluded (not shared — by the migration, by
 * "Don't share" or by withdrawing everything). An excluded row that still has
 * `lastSentHash` is on the hub and waits for its DELETE.
 *
 * A proposal's row is created (when sharing is on) and marked dirty (status,
 * note or vote changed) by the contribute store itself, in the same
 * transaction as the change; see db-store.ts / memory-store.ts there.
 */

export const OUTBOX_STATES = ['pending', 'scrubbed', 'sent', 'failed', 'excluded'] as const
export type OutboxState = (typeof OUTBOX_STATES)[number]

export type OutboxEntry = {
  contributionId: string
  state: OutboxState
  summary: string | null
  language: string | null
  /** Hash of the payload the hub has; null = nothing of this proposal is on the hub. */
  lastSentHash: string | null
  attempts: number
  nextAttemptAt: Date
  lastError: string | null
  sentAt: Date | null
  /** Also the claim token: a claim stamps it, any later change moves it. */
  updatedAt: Date
}

export type ShareSettings = {
  enabled: boolean
  installId: string | null
  registeredAt: Date | null
  revokedAt: Date | null
  /** The last install-level error (registration, revocation, withdrawal). */
  lastError: string | null
  updatedAt: Date
}

export type OutboxCounts = {
  /** pending + scrubbed */
  waiting: number
  sent: number
  failed: number
  /** Not shared but still on the hub (a DELETE is queued). */
  withdrawing: number
  /** The newest row error, with when it happened. */
  lastError: { message: string; at: Date } | null
}

export type ShareStore = {
  settings(): Promise<ShareSettings>
  setEnabled(enabled: boolean, at: Date): Promise<void>
  setInstallId(installId: string, at: Date): Promise<void>
  /** Registered with the hub (null: register again before the next send). */
  setRegistered(registeredAt: Date | null, at: Date): Promise<void>
  setRevoked(revokedAt: Date, error: string): Promise<void>
  setLastError(error: string | null, at: Date): Promise<void>

  entry(id: string): Promise<OutboxEntry | null>
  entries(ids: readonly string[]): Promise<Map<string, OutboxEntry>>
  counts(): Promise<OutboxCounts>

  /** "Don't share": the row becomes excluded (created when there is none); a sent one is then withdrawn by the worker. */
  exclude(id: string, at: Date): Promise<void>
  /** Whether a claim would find anything (the worker registers only then). */
  hasDue(now: Date): Promise<boolean>
  /**
   * Claim up to `limit` due rows (SKIP LOCKED): pending/scrubbed to send, and
   * excluded ones still on the hub to withdraw. Each claimed row gets
   * next_attempt_at = leaseUntil and updated_at = now (its claim token).
   */
  claimDue(now: Date, limit: number, leaseUntil: Date): Promise<OutboxEntry[]>
  /** Store the scrub; pending → scrubbed. Keeps the claim token. */
  saveScrub(id: string, scrubbed: { summary: string; language: string }): Promise<void>
  /**
   * The hub has this payload. When nothing touched the row since the claim it
   * is `sent`; otherwise (a vote, a status change, "Don't share" meanwhile) its
   * state stays and it is due again at once.
   */
  markSent(id: string, hash: string, at: Date, claimToken: Date): Promise<void>
  /** Try again later (network, 5xx, 429, no AI provider yet). */
  markRetry(id: string, error: string, attempts: number, nextAttemptAt: Date, at: Date): Promise<void>
  /** Refused for good: pending/scrubbed → failed, no retry. An excluded row stays excluded. */
  markFailed(id: string, error: string, at: Date): Promise<void>
  /** The hub no longer has it (DELETE done). */
  markWithdrawn(id: string, at: Date): Promise<void>
  /** After DELETE install: every row is excluded and nothing is on the hub. */
  withdrawAll(at: Date): Promise<void>
}
