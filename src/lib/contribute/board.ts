import type { ContributionDto, ContributionStatus } from '../../../modules/contribute/types'

/** The board's tabs (declined proposals are off the board). */
export const BOARD_TABS = ['requested', 'in_progress', 'shipped'] as const satisfies readonly ContributionStatus[]
export type BoardTab = (typeof BOARD_TABS)[number]

/** Invalidation key: the board's load depends on it; the composer invalidates it after a share. */
export const CONTRIBUTE_DEPENDENCY = 'app:contribute'

/** The proposals of one tab, keeping the server's board order. */
export function inTab(proposals: readonly ContributionDto[], tab: BoardTab): ContributionDto[] {
  return proposals.filter((p) => p.status === tab)
}

export function tabCounts(proposals: readonly ContributionDto[]): Record<BoardTab, number> {
  const counts: Record<BoardTab, number> = { requested: 0, in_progress: 0, shipped: 0 }
  for (const p of proposals) if (p.status in counts) counts[p.status as BoardTab]++
  return counts
}

/** Clicking the arrow you already chose takes the vote back. */
export function nextVote(current: -1 | 0 | 1, clicked: -1 | 1): -1 | 0 | 1 {
  return current === clicked ? 0 : clicked
}
