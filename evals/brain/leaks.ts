import type { CrawlCall } from './crawl'
import type { CompanyFixture, KnowsItem, LeakItem, MemberKey } from './types'
import { listSources } from './fixture/audience'
import { COMPANY } from './fixture/company'

/**
 * Marker provenance (see types.ts SourceBase): a source's marker in a tool
 * output means that source's content reached the member. Exact tokens, not
 * meaning — paraphrase is the real-model judge's job.
 */

export type Crawls = Partial<Record<MemberKey, CrawlCall[]>>
export type Exposure = { member: MemberKey; sourceId: string; entitled: boolean; tools: string[] }

export function exposures(f: CompanyFixture, crawls: Crawls): Exposure[] {
  const out: Exposure[] = []
  const sources = listSources(f)
  for (const [member, calls] of Object.entries(crawls) as Array<[MemberKey, CrawlCall[]]>) {
    for (const s of sources) {
      const tools = [...new Set(calls.filter((c) => c.output.includes(s.marker)).map((c) => c.tool))]
      if (tools.length > 0) out.push({ member, sourceId: s.id, entitled: s.audience.has(member), tools })
    }
  }
  return out
}

const callsOf = (crawls: Crawls, member: MemberKey): CrawlCall[] => {
  const calls = crawls[member]
  if (!calls) throw new Error(`no crawl for ${member}`)
  return calls
}

const markerOf = (sourceId: string): string => {
  const s = listSources(COMPANY).find((x) => x.id === sourceId)
  if (!s) throw new Error(`unknown fixture source ${sourceId}`)
  return s.marker
}

const reached = (calls: CrawlCall[], sourceId: string) => {
  const marker = markerOf(sourceId)
  return calls.some((c) => c.output.includes(marker))
}

export type LeakCheck = { id: string; asker: MemberKey; pass: boolean; leaked: string[] }

export function leakChecks(items: LeakItem[], crawls: Crawls): LeakCheck[] {
  return items.map((item) => {
    const calls = callsOf(crawls, item.asker)
    const leaked = item.protects.filter((id) => reached(calls, id))
    return { id: item.id, asker: item.asker, pass: leaked.length === 0, leaked }
  })
}

export type KnowsReach = { id: string; asker: MemberKey; reachable: boolean; reached: string[]; missing: string[] }

export function knowsReach(items: KnowsItem[], crawls: Crawls): KnowsReach[] {
  return items.map((item) => {
    const calls = callsOf(crawls, item.asker)
    const hit = item.sources.filter((id) => reached(calls, id))
    const missing = item.sources.filter((id) => !hit.includes(id))
    return { id: item.id, asker: item.asker, reachable: missing.length === 0, reached: hit, missing }
  })
}
