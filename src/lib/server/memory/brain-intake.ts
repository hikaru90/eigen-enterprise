import {
  INTAKE_PERIOD_DAYS,
  intakeItemHref,
  intakeSourceKey,
  type BrainIntake,
  type IntakeCounts,
  type IntakeItem,
  type IntakeSource,
  type IntakeSourceTotal,
} from '$lib/memory/brain-intake'
import { brainKnowsSource } from '$lib/memory/brain-knows'
import type { CaptureSource, MemoryAuthor } from '$lib/server/db/schema'

/**
 * What the brain took in, as one reader may see it (Contribute 30a8d920 part 2;
 * src/lib/memory/brain-intake.ts says what the page shows). Who sees what is the
 * same rule the other Memory reads apply, written into every query (row-level
 * security holds underneath):
 *   - thoughts: the reader's own only (a person's thoughts are theirs alone —
 *     capture/service.ts listThoughts' default reach);
 *   - documents: the reader's own, and colleagues' shared ('company') ones —
 *     never a colleague's private one (text-files/service.ts scopeCondition 'all').
 * Every thought the reader holds counts, done and archived ones too: they are
 * still stored. Counts and sources are structure read off the rows, no model.
 * The queries live in brain-intake-store.ts.
 */

export type IntakeSince = Record<Exclude<keyof IntakeCounts, 'all'>, Date>

export type IntakeThoughtGroup = {
  captureSource: CaptureSource | null
  author: MemoryAuthor
  authorLabel: string | null
} & IntakeCounts

export type IntakeDocumentGroup = { own: boolean } & IntakeCounts

export type IntakeThoughtRow = {
  id: string
  text: string
  category: string
  captureSource: CaptureSource | null
  author: MemoryAuthor
  authorLabel: string | null
  createdAt: Date
}

export type IntakeDocumentRow = {
  id: string
  own: boolean
  ownerName: string
  title: string
  createdAt: Date
}

/** The four reads, each as the reader (live: liveBrainIntakeStore). */
export type BrainIntakeStore = {
  thoughtGroups(readerId: string, since: IntakeSince): Promise<IntakeThoughtGroup[]>
  documentGroups(readerId: string, since: IntakeSince): Promise<IntakeDocumentGroup[]>
  recentThoughts(readerId: string, limit: number): Promise<IntakeThoughtRow[]>
  recentDocuments(readerId: string, limit: number): Promise<IntakeDocumentRow[]>
}

const DAY_MS = 24 * 60 * 60 * 1000
const TITLE_MAX = 160

export function intakeSince(now: Date): IntakeSince {
  const back = (days: number) => new Date(now.getTime() - days * DAY_MS)
  return {
    day: back(INTAKE_PERIOD_DAYS.day),
    week: back(INTAKE_PERIOD_DAYS.week),
    month: back(INTAKE_PERIOD_DAYS.month),
  }
}

const zero = (): IntakeCounts => ({ day: 0, week: 0, month: 0, all: 0 })

function titleLine(text: string): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX).trimEnd()}…` : line
}

export function buildBrainIntake(input: {
  now: Date
  thoughtGroups: IntakeThoughtGroup[]
  documentGroups: IntakeDocumentGroup[]
  recentThoughts: IntakeThoughtRow[]
  recentDocuments: IntakeDocumentRow[]
  limit: number
}): BrainIntake {
  const bySource = new Map<string, IntakeSourceTotal>()
  const totals = zero()
  const add = (source: IntakeSource, counts: IntakeCounts) => {
    const key = intakeSourceKey(source)
    const entry = bySource.get(key) ?? { source, counts: zero() }
    for (const period of ['day', 'week', 'month', 'all'] as const) {
      entry.counts[period] += counts[period]
      totals[period] += counts[period]
    }
    bySource.set(key, entry)
  }
  for (const g of input.thoughtGroups) {
    add(
      brainKnowsSource({ source: g.captureSource, author: g.author, authorLabel: g.authorLabel }),
      g,
    )
  }
  for (const g of input.documentGroups) {
    add({ kind: g.own ? 'own_document' : 'shared_document' }, g)
  }

  const thoughts: IntakeItem[] = input.recentThoughts.map((row) => ({
    kind: 'thought',
    id: row.id,
    at: row.createdAt.toISOString(),
    title: titleLine(row.text),
    category: row.category,
    sharedBy: null,
    source: brainKnowsSource({
      source: row.captureSource,
      author: row.author,
      authorLabel: row.authorLabel,
    }),
    href: intakeItemHref('thought', row.id),
  }))
  const documents: IntakeItem[] = input.recentDocuments.map((row) => ({
    kind: 'document',
    id: row.id,
    at: row.createdAt.toISOString(),
    title: row.title.trim() || null,
    category: null,
    sharedBy: row.own ? null : row.ownerName,
    source: { kind: row.own ? 'own_document' : 'shared_document' },
    href: intakeItemHref('document', row.id),
  }))

  return {
    asOf: input.now.toISOString(),
    totals,
    // Most first (a stable sort: thought sources before documents on a tie); nothing-yet sources left out.
    bySource: [...bySource.values()]
      .filter((e) => e.counts.all > 0)
      .sort((a, b) => b.counts.all - a.counts.all),
    recent: [...thoughts, ...documents]
      .sort((a, b) => (a.at === b.at ? a.id.localeCompare(b.id) : b.at.localeCompare(a.at)))
      .slice(0, input.limit),
  }
}

export async function loadBrainIntake(
  readerId: string,
  opts: { limit: number; now?: Date },
  store: BrainIntakeStore,
): Promise<BrainIntake> {
  const now = opts.now ?? new Date()
  const since = intakeSince(now)
  const [thoughtGroups, documentGroups, recentThoughts, recentDocuments] = await Promise.all([
    store.thoughtGroups(readerId, since),
    store.documentGroups(readerId, since),
    store.recentThoughts(readerId, opts.limit),
    store.recentDocuments(readerId, opts.limit),
  ])
  return buildBrainIntake({
    now,
    thoughtGroups,
    documentGroups,
    recentThoughts,
    recentDocuments,
    limit: opts.limit,
  })
}
