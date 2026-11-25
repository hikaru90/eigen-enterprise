import { brainKnowsSourceLabel, type BrainKnowsSource } from '$lib/memory/brain-knows'
import { m } from '$lib/paraglide/messages.js'

/**
 * Memory › What the brain took in (Contribute 30a8d920, part 2: "trace what the
 * company brain has already taken in … full transparency"): how much the brain
 * holds, from which source, in which period, and the newest items — only what
 * the reader may see: their own thoughts (a person's thoughts are theirs alone),
 * their own documents and the documents colleagues share; never a colleague's
 * thought or private document. Counts and sources are read straight off the
 * stored rows (capture_source, author, owner) — structure, no model. Shared by
 * the page and the memory.intake registry tool, so the CLI and the agent see
 * what the person sees.
 */

/** How many of the newest items the page (and memory.intake by default) lists. */
export const BRAIN_INTAKE_LIMIT = 30
export const BRAIN_INTAKE_MAX_LIMIT = 100

/** Rolling windows back from now (no calendar days: no time-zone guess), then everything. */
export const INTAKE_PERIODS = ['day', 'week', 'month', 'all'] as const
export type IntakePeriod = (typeof INTAKE_PERIODS)[number]
export const INTAKE_PERIOD_DAYS: Record<Exclude<IntakePeriod, 'all'>, number> = {
  day: 1,
  week: 7,
  month: 30,
}

export type IntakeCounts = Record<IntakePeriod, number>

/** Where an item came from: a thought's capture source, or a document (own or a colleague's shared one). */
export type IntakeSource = BrainKnowsSource | { kind: 'own_document' } | { kind: 'shared_document' }

export type IntakeSourceTotal = { source: IntakeSource; counts: IntakeCounts }

export type IntakeItem = {
  kind: 'thought' | 'document'
  id: string
  /** When the brain took it in (ISO). */
  at: string
  /** A thought's text (shortened), a document's title; null = an untitled document. */
  title: string | null
  /** A thought's category; null for documents. */
  category: string | null
  /** The colleague who shared a document; null for the reader's own items. */
  sharedBy: string | null
  source: IntakeSource
  /** Where it opens in the app (path + query; intakeItemLink gives the parts). */
  href: string
}

export type BrainIntake = {
  asOf: string
  totals: IntakeCounts
  bySource: IntakeSourceTotal[]
  recent: IntakeItem[]
}

/** Where an item opens: a thought on What the brain knows, a document in Documents. */
export function intakeItemLink(
  kind: IntakeItem['kind'],
  id: string,
): { path: '/m/memory/capture' | '/m/memory/notes'; query: string } {
  const q = encodeURIComponent(id)
  return kind === 'thought'
    ? { path: '/m/memory/capture', query: `thought=${q}` }
    : { path: '/m/memory/notes', query: `note=${q}` }
}

export function intakeItemHref(kind: IntakeItem['kind'], id: string): string {
  const link = intakeItemLink(kind, id)
  return `${link.path}?${link.query}`
}

/** One key per source (a connected agent per name), so counts of the same source add up. */
export function intakeSourceKey(source: IntakeSource): string {
  return source.kind === 'connected_agent' ? `connected_agent:${source.name ?? ''}` : source.kind
}

export function intakeSourceLabel(source: IntakeSource): string {
  if (source.kind === 'own_document') return m.memory_intake_source_own_document()
  if (source.kind === 'shared_document') return m.memory_intake_source_shared_document()
  return brainKnowsSourceLabel(source)
}

export function intakePeriodLabel(period: IntakePeriod): string {
  switch (period) {
    case 'day':
      return m.memory_intake_period_day()
    case 'week':
      return m.memory_intake_period_week()
    case 'month':
      return m.memory_intake_period_month()
    case 'all':
      return m.memory_intake_period_all()
  }
}
