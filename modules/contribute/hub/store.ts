import type { ContributionArea, ContributionKind, ContributionStatus } from '../types'

/** A registered install (hub_installs). */
export type HubInstall = {
  installId: string
  /** Ed25519 public key, SPKI DER, base64. */
  publicKey: string
  appVersion: string
  registeredAt: Date
  lastSeenAt: Date
  revokedAt: Date | null
}

/** What an install sends for one proposal (the parsed hubContributionV1, camel-cased). */
export type HubContributionInput = {
  installId: string
  remoteId: string
  summary: string
  language: string
  kind: ContributionKind
  area: ContributionArea
  status: ContributionStatus
  score: number
  appVersion: string
  createdDay: string
  shippedDay: string | null
}

/** A stored proposal (hub_contributions). */
export type HubContribution = HubContributionInput & { updatedAt: Date; receivedAt: Date }

/** created = new row; updated = a field changed; unchanged = the same body again (nothing written). */
export type HubUpsertOutcome = 'created' | 'updated' | 'unchanged'

/** Persistence seam: the DB store in production, the in-memory one in unit tests. */
export type HubStore = {
  getInstall(installId: string): Promise<HubInstall | null>
  /** false when the install id already exists (a concurrent register): nothing is written. */
  insertInstall(install: { installId: string; publicKey: string; appVersion: string; at: Date }): Promise<boolean>
  /** Stamps last_seen_at (and the app version, when given). */
  touchInstall(installId: string, at: Date, appVersion?: string): Promise<void>
  /** Sets revoked_at once (a second revoke keeps the first time); null = unknown install. */
  revokeInstall(installId: string, at: Date): Promise<HubInstall | null>
  /** Removes the install and every proposal it shared; false = unknown install. */
  deleteInstall(installId: string): Promise<boolean>
  upsert(row: HubContributionInput, at: Date): Promise<HubUpsertOutcome>
  /** false = there was no such proposal. */
  deleteContribution(installId: string, remoteId: string): Promise<boolean>
  get(installId: string, remoteId: string): Promise<HubContribution | null>
  /** Every proposal in one of the statuses, highest score first, then most recently updated. */
  list(statuses: readonly ContributionStatus[]): Promise<HubContribution[]>
  /**
   * Replay guard: records a signature hash; false when it was already seen.
   * First drops every hash seen before `pruneBefore` (outside the skew window
   * a signature is refused for its timestamp anyway).
   */
  claimSignature(hash: string, at: Date, pruneBefore: Date): Promise<boolean>
  /**
   * Rate limit: counts one request in the install's hour bucket and returns
   * the bucket's count after it. Drops every bucket older than `hour`.
   */
  countRequest(installId: string, hour: Date): Promise<number>
}
