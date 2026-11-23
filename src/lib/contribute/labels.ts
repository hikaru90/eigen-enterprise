import type { ContributionArea, ContributionKind, ContributionStatus } from '../../../modules/contribute/types'
import { m } from '$lib/paraglide/messages.js'

/**
 * Plain-word labels for the board's vocabulary (presentation only), in the
 * person's UI language. Functions, not constants: the words are read at render
 * time so a language switch shows at once.
 */

export const KIND_LABEL: Record<ContributionKind, () => string> = {
  idea: m.wish_kind_idea,
  bug: m.wish_kind_bug,
  polish: m.wish_kind_polish,
}

/** "Sounds like <phrase> in <area>". */
export const KIND_PHRASE: Record<ContributionKind, () => string> = {
  idea: m.wish_kind_phrase_idea,
  bug: m.wish_kind_phrase_bug,
  polish: m.wish_kind_phrase_polish,
}

export const AREA_LABEL: Record<ContributionArea, () => string> = {
  dashboard: m.wish_area_dashboard,
  assistant: m.wish_area_assistant,
  messages: m.wish_area_messages,
  website: m.wish_area_website,
  email: m.wish_area_email,
  brand: m.wish_area_brand,
  memory: m.wish_area_memory,
  drive: m.wish_area_drive,
  settings: m.wish_area_settings,
  contribute: m.wish_area_contribute,
  everywhere: m.wish_area_everywhere,
}

export const STATUS_LABEL: Record<ContributionStatus, () => string> = {
  requested: m.wish_status_requested,
  in_progress: m.wish_status_in_progress,
  shipped: m.wish_status_shipped,
  declined: m.wish_status_declined,
}

export function votesLabel(score: number): string {
  return Math.abs(score) === 1 ? m.wish_votes_one({ count: score }) : m.wish_votes_other({ count: score })
}
