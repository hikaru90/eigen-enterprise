import { createHash } from 'node:crypto'
import type { ContributionArea, ContributionKind, ContributionStatus } from '../types'
import { HUB_CONTRIBUTION_KEYS, hubContributionV1, type HubContributionV1 } from './contract'

/**
 * The one place a payload for the central board is built
 * (plan/contribute-phone-home.md §4.1): named fields only, then the strict
 * contract schema. The title, author, note and votes per person are not read
 * here at all; the summary is the LLM rewrite from scrub.ts.
 */

/** What of a proposal the payload may read. */
export type PayloadSource = {
  id: string
  kind: ContributionKind
  area: ContributionArea
  status: ContributionStatus
  /** Net votes. */
  score: number
  createdAt: Date
  shippedAt: Date | null
}

export type Scrubbed = { summary: string; language: string }

/** YYYY-MM-DD in UTC: a day, not a timestamp (less correlation). */
export function utcDay(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function toHubPayload(row: PayloadSource, scrubbed: Scrubbed, appVersion: string): HubContributionV1 {
  return hubContributionV1.parse({
    v: 1,
    remote_id: row.id,
    summary: scrubbed.summary,
    language: scrubbed.language,
    kind: row.kind,
    area: row.area,
    status: row.status,
    score: row.score,
    app_version: appVersion,
    created_day: utcDay(row.createdAt),
    shipped_day: row.shippedAt ? utcDay(row.shippedAt) : null,
  })
}

/** The request body: JSON with the contract's key order, so the same payload is the same bytes. */
export function payloadBody(p: HubContributionV1): string {
  return JSON.stringify(Object.fromEntries(HUB_CONTRIBUTION_KEYS.map((k) => [k, p[k]])))
}

/** SHA-256 of the body: the worker sends only when this changed since the last send. */
export function payloadHash(p: HubContributionV1): string {
  return createHash('sha256').update(payloadBody(p)).digest('hex')
}
