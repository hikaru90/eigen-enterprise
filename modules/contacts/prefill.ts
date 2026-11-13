import type { Channel, ContactDraft, LogDraft } from './types'

/**
 * How the AI's draft lands in a form (pure, client side): an empty field is
 * filled in; a field that already holds something else is never overwritten
 * silently — it becomes a change the person accepts or keeps. Channels and
 * tags are only ever added. Nothing here saves: the person presses Save.
 */

export type FieldSpec<K extends string> = { key: K; label: string }
export type Filled<K extends string> = { key: K; label: string; value: string }
export type Change<K extends string> = { key: K; label: string; from: string; to: string }

/** The contact form's text and date fields, labelled as the form labels them. */
export const CONTACT_FIELDS = [
  { key: 'name', label: 'Name' },
  { key: 'organisation', label: 'Organisation' },
  { key: 'title', label: 'Role or title' },
  { key: 'metHow', label: 'Where or how you met' },
  { key: 'whyRelevant', label: 'Why they matter' },
  { key: 'lastContactedOn', label: 'Last in touch' },
  { key: 'nextFollowUpOn', label: 'Next follow-up' },
  { key: 'nextStep', label: 'Next step' },
] as const satisfies ReadonlyArray<FieldSpec<Exclude<keyof ContactDraft, 'channels' | 'tags'>>>

export type ContactFieldKey = (typeof CONTACT_FIELDS)[number]['key']

export const LOG_FIELDS = [
  { key: 'on', label: 'In touch on' },
  { key: 'note', label: 'How it went' },
  { key: 'nextFollowUpOn', label: 'Next follow-up' },
  { key: 'nextStep', label: 'Next step' },
] as const satisfies ReadonlyArray<FieldSpec<keyof LogDraft>>

export type LogFieldKey = (typeof LOG_FIELDS)[number]['key']

/**
 * Per field: not said → nothing; empty (or still at its default) → filled;
 * the same → nothing; something else → a change to review.
 */
export function planFields<K extends string>(
  fields: ReadonlyArray<FieldSpec<K>>,
  current: Record<K, string>,
  draft: Partial<Record<K, string | null>>,
  defaults: Partial<Record<K, string>> = {},
): { filled: Filled<K>[]; changes: Change<K>[] } {
  const filled: Filled<K>[] = []
  const changes: Change<K>[] = []
  for (const { key, label } of fields) {
    const to = draft[key]?.trim() ?? ''
    if (to === '') continue
    const from = current[key].trim()
    if (from === to) continue
    if (from === '' || from === defaults[key]) filled.push({ key, label, value: to })
    else changes.push({ key, label, from, to })
  }
  return { filled, changes }
}

/** The draft's channels the form doesn't hold yet (same type and value). */
export function newChannels(current: readonly Channel[], draft: readonly Channel[]): Channel[] {
  const has = new Set(current.filter((c) => c.value.trim() !== '').map((c) => `${c.type}\n${c.value.trim()}`))
  return draft.filter((c) => !has.has(`${c.type}\n${c.value.trim()}`))
}

/** The draft's tags not checked yet. */
export function newTags(checked: readonly string[], draft: readonly string[]): string[] {
  return draft.filter((t) => !checked.includes(t))
}
