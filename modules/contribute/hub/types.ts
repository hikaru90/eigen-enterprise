import type { ContributionArea, ContributionKind, ContributionStatus } from '../types'

/**
 * The central board's vocabulary, shared by server and browser (pure — no
 * server imports). A hub proposal is what one install shared
 * (modules/contribute/share/contract.ts, hubContributionV1): no author, no
 * votes per person, no company — only a random install id.
 */

/** One shared proposal as the owner (and the owner's agent) reads it. */
export type HubProposalDto = {
  /** The random id the install made for itself (derived from nothing). */
  installId: string
  /** The install's own contribution id (links back only for that install). */
  remoteId: string
  /** The install's LLM rewrite of the title: English, PII-free. */
  summary: string
  /** BCP-47 tag of the original title's language. */
  language: string
  kind: ContributionKind
  area: ContributionArea
  status: ContributionStatus
  /** Net votes on that install's board. */
  score: number
  appVersion: string
  createdDay: string
  shippedDay: string | null
  updatedAt: string
  receivedAt: string
}

/** The board's statuses in reading order (requested first). */
export const HUB_STATUS_ORDER: readonly ContributionStatus[] = ['requested', 'in_progress', 'shipped', 'declined']
