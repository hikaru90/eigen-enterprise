import type { ContributionArea, ContributionKind, ContributionStatus } from '../../../modules/contribute/types'

/** Plain-word labels for the board's vocabulary (presentation only). */

export const KIND_LABEL: Record<ContributionKind, string> = { idea: 'Idea', bug: 'Bug', polish: 'Polish' }

/** "Sounds like <phrase> in <area>". */
export const KIND_PHRASE: Record<ContributionKind, string> = { idea: 'an idea', bug: 'a bug', polish: 'polish' }

export const AREA_LABEL: Record<ContributionArea, string> = {
  dashboard: 'Dashboard',
  assistant: 'Assistant',
  messages: 'Messages',
  website: 'Website',
  email: 'Email',
  brand: 'Brand',
  memory: 'Memory',
  drive: 'Drive',
  settings: 'Settings',
  contribute: 'Contribute',
  everywhere: 'the whole app',
}

export const STATUS_LABEL: Record<ContributionStatus, string> = {
  requested: 'Requested',
  in_progress: 'In progress',
  shipped: 'Shipped',
  declined: 'Declined',
}

export function votesLabel(score: number): string {
  return `${score} ${Math.abs(score) === 1 ? 'vote' : 'votes'}`
}
