import { z } from 'zod'

/**
 * What's happening (wish 75a4e570, inspired by eigenmesh's patterns): the company brain tells
 * everyone on the dashboard what people did lately and what recurs, as observations a camera
 * could make ("Anna changed things in Drive 12 times, on 5 of the last 7 days"), never an
 * evaluation of anyone.
 *
 * The split follows the decision-shape maxim: which facts exist is structure (counts and
 * distinct days over the audit trail's `tool.executed` events, no model); the LLM only writes
 * one sentence per fact, once per digest, never per view. Each fact is built from one module's
 * tools only and remembers them, so a viewer gets exactly the facts whose every tool they may
 * run and whose module is active (the registry's own permission roles).
 */

/** The window a digest looks back over. */
export const PATTERN_WINDOW_DAYS = 7
/** A person × module with activity on at least this many distinct days is a recurring pattern. */
export const RECURRING_MIN_DAYS = 3
/** At most this many facts per digest (the busiest first): the card stays short and the prompt small. */
export const MAX_FACTS = 12

/** One audited change: who (principal id) ran which tool, when. Reads are not activity. */
export type ActivityEvent = { principalId: string; tool: string; at: Date }

/** Structure the facts are built from: tool → its module and permission roles. */
export type ToolCatalog = (tool: string) => { module: string; roles: readonly string[] } | null

export const patternFactSchema = z.object({
  id: z.string(),
  kind: z.enum(['activity', 'recurring']),
  personId: z.string(),
  personName: z.string(),
  module: z.string(),
  moduleLabel: z.string(),
  /** How many changes in the window. */
  count: z.number().int().positive(),
  /** On how many distinct (UTC) days. */
  days: z.number().int().positive(),
  /** The tools counted: a viewer must be allowed every one of them. */
  tools: z.array(z.string()).min(1),
  /** Roles each counted tool admits, intersected: the viewer needs one of them. */
  roles: z.array(z.string()),
})
export type PatternFact = z.infer<typeof patternFactSchema>

export const patternItemSchema = patternFactSchema.extend({ text: z.string().min(1) })
export type PatternItem = z.infer<typeof patternItemSchema>

export type PatternDigest = {
  id: string
  createdAt: Date
  windowStart: Date
  windowEnd: Date
  items: PatternItem[]
}

const dayKey = (d: Date) => d.toISOString().slice(0, 10)

/**
 * The facts of one window, busiest first. Events of unknown tools (no longer registered) and of
 * principals without a name (no longer an account) are left out: nobody to name, nothing to check.
 */
export function buildPatternFacts(input: {
  events: readonly ActivityEvent[]
  catalog: ToolCatalog
  personName: (principalId: string) => string | null
  moduleLabel: (moduleId: string) => string
}): PatternFact[] {
  const groups = new Map<
    string,
    { personId: string; module: string; count: number; days: Set<string>; tools: Set<string>; roles: Set<string> | null }
  >()
  for (const event of input.events) {
    const tool = input.catalog(event.tool)
    if (!tool) continue
    const key = `${event.principalId}\u0000${tool.module}`
    let group = groups.get(key)
    if (!group) {
      group = { personId: event.principalId, module: tool.module, count: 0, days: new Set(), tools: new Set(), roles: null }
      groups.set(key, group)
    }
    group.count += 1
    group.days.add(dayKey(event.at))
    group.tools.add(event.tool)
    const roles = new Set(tool.roles)
    group.roles = group.roles === null ? roles : new Set([...group.roles].filter((r) => roles.has(r)))
  }

  const facts: PatternFact[] = []
  for (const group of groups.values()) {
    const personName = input.personName(group.personId)
    if (!personName) continue
    const days = group.days.size
    facts.push({
      id: `${group.personId}:${group.module}`,
      kind: days >= RECURRING_MIN_DAYS ? 'recurring' : 'activity',
      personId: group.personId,
      personName,
      module: group.module,
      moduleLabel: input.moduleLabel(group.module),
      count: group.count,
      days,
      tools: [...group.tools].sort(),
      roles: [...(group.roles ?? [])].sort(),
    })
  }
  facts.sort((a, b) => b.count - a.count || b.days - a.days || a.id.localeCompare(b.id))
  return facts.slice(0, MAX_FACTS)
}

/** The items a viewer may see: the module is active and the viewer holds a role every counted tool admits. */
export function visibleItems(
  items: readonly PatternItem[],
  viewer: { roles: readonly string[]; moduleActive: (moduleId: string) => boolean },
): PatternItem[] {
  return items.filter((item) => viewer.moduleActive(item.module) && item.roles.some((r) => viewer.roles.includes(r)))
}

/** The one writing call per digest: the facts in, one plain sentence per fact id out. */
export function patternSentenceMessages(facts: readonly PatternFact[]): { role: 'system' | 'user'; content: string }[] {
  return [
    {
      role: 'system',
      content: [
        'You write the "What\'s happening" card on a company dashboard.',
        'For every fact write exactly one short sentence (at most 20 words) a colleague reads at a glance.',
        'Say only what a camera could have observed: who did how much where, on how many days.',
        'Never evaluate, praise, compare or guess intent ("only", "a lot", "productive", "busy" are evaluations).',
        'Use the person\'s name and the module label as given. "recurring" means it happened on several days; say on how many.',
        'Answer JSON only: {"sentences": {"<fact id>": "<sentence>", ...}} with every fact id once.',
      ].join('\n'),
    },
    {
      role: 'user',
      content: JSON.stringify({
        window_days: PATTERN_WINDOW_DAYS,
        facts: facts.map((f) => ({
          id: f.id,
          kind: f.kind,
          person: f.personName,
          module: f.moduleLabel,
          changes: f.count,
          days_active: f.days,
        })),
      }),
    },
  ]
}

const sentencesSchema = z.object({ sentences: z.record(z.string(), z.string().trim().min(1)) })

/** Parses the model's answer: every fact gets its sentence, or the digest fails loud. */
export function parsePatternSentences(content: string, facts: readonly PatternFact[]): PatternItem[] {
  let raw: unknown
  try {
    raw = JSON.parse(content)
  } catch {
    throw new Error(`patterns digest: the model's answer is not JSON: ${content.slice(0, 200)}`)
  }
  const parsed = sentencesSchema.safeParse(raw)
  if (!parsed.success) throw new Error(`patterns digest: the model's answer has no sentences map: ${parsed.error.message}`)
  return facts.map((fact) => {
    const text = parsed.data.sentences[fact.id]
    if (!text) throw new Error(`patterns digest: the model wrote no sentence for fact ${fact.id}`)
    return { ...fact, text }
  })
}
