/**
 * The board's vocabulary, shared by client and server (pure — no server imports).
 * Keys are the DB check-constraint values (migration 0121).
 */

export const CONTRIBUTION_KINDS = ['idea', 'bug', 'polish'] as const
export type ContributionKind = (typeof CONTRIBUTION_KINDS)[number]

export const CONTRIBUTION_AREAS = [
  'dashboard',
  'assistant',
  'messages',
  'website',
  'email',
  'brand',
  'memory',
  'drive',
  'settings',
  'contribute',
  'everywhere',
] as const
export type ContributionArea = (typeof CONTRIBUTION_AREAS)[number]

/** requested → in_progress → shipped; declined takes it off the board (any status restores it). */
export const CONTRIBUTION_STATUSES = ['requested', 'in_progress', 'shipped', 'declined'] as const
export type ContributionStatus = (typeof CONTRIBUTION_STATUSES)[number]

/** Open = still to be done: the judge compares new drafts against these. */
export const OPEN_STATUSES: readonly ContributionStatus[] = ['requested', 'in_progress']

export type MyVote = -1 | 0 | 1

/** Shared by the composer and the server: the longest proposal accepted (after trim). */
export const CONTRIBUTION_MAX_LENGTH = 2000
/** The longest note the makers (or the agent) leave on a proposal. */
export const CONTRIBUTION_NOTE_MAX_LENGTH = 1000

/** One proposal as the board (and the agent) sees it. */
export type ContributionDto = {
  id: string
  title: string
  kind: ContributionKind
  area: ContributionArea
  status: ContributionStatus
  /** Net votes (+1 / -1 each). */
  score: number
  /** The viewer's vote; always 0 for the agent. */
  myVote: MyVote
  /** The viewer wrote it. */
  own: boolean
  authorId: string
  authorName: string
  /** The makers' (or agent's) note, shown on the proposal. */
  note: string | null
  createdAt: string
  updatedAt: string
  shippedAt: string | null
}

/** What the judge read from a draft, and the same request already on the board if any. */
export type ContributionCheck = {
  kind: ContributionKind
  area: ContributionArea
  duplicateOf: ContributionDto | null
}
