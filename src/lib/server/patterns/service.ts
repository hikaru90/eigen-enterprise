import {
  buildPatternFacts,
  parsePatternSentences,
  patternSentenceMessages,
  PATTERN_WINDOW_DAYS,
  visibleItems,
  type ActivityEvent,
  type PatternDigest,
  type PatternItem,
  type ToolCatalog,
} from './digest'

/** A fresh digest is written at most this often by the background tick. */
export const DIGEST_EVERY_MS = 24 * 60 * 60 * 1000

export type PatternDeps = {
  now: () => Date
  /** Audited changes (no reads, ok only) since the given time. */
  events: (since: Date) => Promise<ActivityEvent[]>
  catalog: ToolCatalog
  personNames: (ids: readonly string[]) => Promise<Map<string, string>>
  moduleLabel: (moduleId: string) => string
  /** The one LLM call per digest: messages in, the model's JSON text out. */
  write: (messages: ReturnType<typeof patternSentenceMessages>) => Promise<string>
  latest: () => Promise<PatternDigest | null>
  save: (digest: Omit<PatternDigest, 'id' | 'createdAt'>) => Promise<PatternDigest>
}

/** Builds and stores a new digest of the last window. No activity → a digest with no items, and no model call. */
export async function refreshPatternDigest(deps: PatternDeps): Promise<PatternDigest> {
  const windowEnd = deps.now()
  const windowStart = new Date(windowEnd.getTime() - PATTERN_WINDOW_DAYS * 24 * 60 * 60 * 1000)
  const events = await deps.events(windowStart)
  const names = await deps.personNames([...new Set(events.map((e) => e.principalId))])
  const facts = buildPatternFacts({
    events,
    catalog: deps.catalog,
    personName: (id) => names.get(id) ?? null,
    moduleLabel: deps.moduleLabel,
  })
  const items: PatternItem[] = facts.length === 0 ? [] : parsePatternSentences(await deps.write(patternSentenceMessages(facts)), facts)
  return deps.save({ windowStart, windowEnd, items })
}

/** The background tick: a new digest once the latest is a day old (or there is none). */
export async function patternDigestDue(deps: Pick<PatternDeps, 'now' | 'latest'>): Promise<boolean> {
  const latest = await deps.latest()
  return latest === null || deps.now().getTime() - latest.createdAt.getTime() >= DIGEST_EVERY_MS
}

export type PatternView = {
  digestId: string | null
  createdAt: string | null
  windowStart: string | null
  windowEnd: string | null
  items: { id: string; kind: PatternItem['kind']; personId: string; personName: string; module: string; moduleLabel: string; count: number; days: number; text: string }[]
}

/** The latest digest as this viewer may see it. */
export async function patternsFor(
  deps: Pick<PatternDeps, 'latest'>,
  viewer: { roles: readonly string[]; moduleActive: (moduleId: string) => boolean },
): Promise<PatternView> {
  const latest = await deps.latest()
  if (!latest) return { digestId: null, createdAt: null, windowStart: null, windowEnd: null, items: [] }
  return {
    digestId: latest.id,
    createdAt: latest.createdAt.toISOString(),
    windowStart: latest.windowStart.toISOString(),
    windowEnd: latest.windowEnd.toISOString(),
    items: visibleItems(latest.items, viewer).map(({ id, kind, personId, personName, module, moduleLabel, count, days, text }) => ({
      id,
      kind,
      personId,
      personName,
      module,
      moduleLabel,
      count,
      days,
      text,
    })),
  }
}
