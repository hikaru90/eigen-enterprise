/**
 * "Would pick up" on an AI co-worker's profile (plan/phase-ai-coworkers.md C7): one shadow
 * decision of kind coworkers.event_mine as the page shows it, and the counted outcomes of
 * the events it heard (coworkers.event_subscriptions_get).
 */
export type PickupItem = {
  id: string
  at: string
  channel: string
  privateChannel: boolean
  /** Only for a public channel (the log keeps no private text). */
  excerpt: string | null
  threadUrl: string | null
  jevChoice: 'yes' | 'no' | null
  jevConfidence: number | null
  humanChoice: 'yes' | 'no' | null
}

export type PickupCounts = { observed: number; queued: number; failed: number; skipped_daily_cap: number; skipped_author_cap: number }
