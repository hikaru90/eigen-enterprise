import type { CrawlCall } from '../crawl'
import type { Crawls } from '../leaks'
import type { CompanyFixture, CoworkerKey, MemberKey, SeatKey } from '../types'
import { listSources } from '../fixture/audience'
import { reached } from '../leaks'
import { COWORKER_LEAKS, COWORKER_REACH } from '../suites/coworkers'

/**
 * Co-workers / Keeps from the tool-level crawl (no model): which protected
 * markers reached a co-worker (and through which hand: a direct tool, `ee:`,
 * retrieval), which shared sources reached whom, and how Memory hands a
 * co-worker's thought to a person (owner kind, `editable`) — structure parsed
 * from the tool output, never meaning.
 */

export type CoworkerLeakResult = { id: string; concept: string; pass: boolean; leaked: Array<{ coworker: CoworkerKey; sourceId: string; tools: string[] }> }
export type CoworkerReachResult = { id: string; concept: string; pass: boolean; missing: Array<{ seat: SeatKey; sourceId: string }> }
/** How each person's retrieval presents each co-worker thought it returns. */
export type ReadOnlyView = { member: MemberKey; sourceId: string; ownerKind: unknown; editable: unknown }
export type ReadOnlyViewResult = { pass: boolean; views: ReadOnlyView[]; wrong: ReadOnlyView[] }

const callsOf = (crawls: Crawls, seat: SeatKey): CrawlCall[] => {
  const calls = crawls[seat]
  if (!calls) throw new Error(`no crawl for ${seat}`)
  return calls
}

export function coworkerLeakResults(f: CompanyFixture, crawls: Crawls): CoworkerLeakResult[] {
  return COWORKER_LEAKS.map((item) => {
    const leaked: CoworkerLeakResult['leaked'] = []
    for (const c of f.coworkers) {
      const calls = callsOf(crawls, c.key)
      for (const sourceId of item.protects) {
        if (!reached(calls, sourceId)) continue
        leaked.push({ coworker: c.key, sourceId, tools: toolsReaching(calls, f, sourceId) })
      }
    }
    return { id: item.id, concept: item.concept, pass: leaked.length === 0, leaked }
  })
}

export function coworkerReachResults(crawls: Crawls): CoworkerReachResult[] {
  return COWORKER_REACH.map((item) => {
    const missing: CoworkerReachResult['missing'] = []
    for (const seat of item.seats) {
      const calls = callsOf(crawls, seat)
      for (const sourceId of item.sources) if (!reached(calls, sourceId)) missing.push({ seat, sourceId })
    }
    return { id: item.id, concept: item.concept, pass: missing.length === 0, missing }
  })
}

function toolsReaching(calls: CrawlCall[], f: CompanyFixture, sourceId: string): string[] {
  const marker = markerOf(f, sourceId)
  return [...new Set(calls.filter((c) => c.output.includes(marker)).map((c) => c.tool))]
}

function markerOf(f: CompanyFixture, sourceId: string): string {
  const s = listSources(f).find((x) => x.id === sourceId)
  if (!s) throw new Error(`unknown fixture source ${sourceId}`)
  return s.marker
}

type Hit = { id?: unknown; owner?: { kind?: unknown }; editable?: unknown }

/**
 * Every co-worker thought a person's memory.retrieve_thoughts returned must
 * come with `owner.kind 'coworker'` and `editable: false`; and every person
 * must have been handed every co-worker thought (else there is nothing to judge).
 */
export function readOnlyViews(f: CompanyFixture, crawls: Crawls, seededIds: Map<string, string>): ReadOnlyViewResult {
  const coworkerThoughts = f.thoughts.filter((t) => f.coworkers.some((c) => c.key === t.owner))
  const byProductId = new Map(coworkerThoughts.map((t) => [seededIds.get(t.id), t.id]))
  const views: ReadOnlyView[] = []
  for (const m of f.members) {
    const seen = new Set<string>()
    for (const call of callsOf(crawls, m.key).filter((c) => c.tool === 'memory.retrieve_thoughts' && c.ok)) {
      const out = JSON.parse(call.output) as { results?: Hit[] }
      for (const hit of out.results ?? []) {
        const sourceId = typeof hit.id === 'string' ? byProductId.get(hit.id) : undefined
        if (!sourceId || seen.has(sourceId)) continue
        seen.add(sourceId)
        views.push({ member: m.key, sourceId, ownerKind: hit.owner?.kind, editable: hit.editable })
      }
    }
    for (const t of coworkerThoughts) if (!seen.has(t.id)) views.push({ member: m.key, sourceId: t.id, ownerKind: 'not returned', editable: 'not returned' })
  }
  const wrong = views.filter((v) => v.ownerKind !== 'coworker' || v.editable !== false)
  return { pass: wrong.length === 0, views, wrong }
}
