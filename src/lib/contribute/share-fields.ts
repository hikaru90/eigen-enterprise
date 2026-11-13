import type { HubContributionV1 } from '../../../modules/contribute/share/contract'
import type { ShareItemState } from '../../../modules/contribute/share/service'

/**
 * What a shared proposal carries, in plain words, one line per contract
 * field (modules/contribute/share/contract.ts) — typed by the contract, so a
 * new field cannot ship without its line here.
 */
export const SHARED_FIELDS: Record<keyof HubContributionV1, string> = {
  v: 'Format version',
  remote_id: 'A random id for the proposal (it links back only on this server)',
  summary: 'A short English summary, rewritten by your AI provider on this server without names, contacts, the company, places, links or secrets',
  language: 'The language it was written in',
  kind: 'Kind (idea, bug, polish)',
  area: 'Area of the app',
  status: 'Status (requested, in progress, shipped, declined)',
  score: 'Net votes — a count, never who voted',
  app_version: 'App version',
  created_day: 'The day it was proposed',
  shipped_day: 'The day it shipped',
}

/** What never leaves the company. */
export const NEVER_SHARED = [
  'Who proposed or voted, names, emails',
  'The proposal in its own words, and notes',
  'Exact times',
  "The company's name, domain or members",
] as const

export const SHARE_STATE_LABEL: Record<ShareItemState, string> = {
  waiting: 'Waiting',
  shared: 'Shared',
  not_shared: 'Not shared',
  failed: 'Failed',
}
