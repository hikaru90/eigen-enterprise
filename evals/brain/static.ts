import type { EvalCompany } from './harness'
import type { CompanyFixture, MemberKey } from './types'
import { CRAWLED_TOOLS, crawlAsMember, type CrawlCall } from './crawl'
import { localDateOf } from './fixture/time'
import { exposures, knowsReach, leakChecks, type Crawls, type Exposure, type KnowsReach, type LeakCheck } from './leaks'
import { KEEPS, KNOWS } from './suites'

/**
 * Deterministic mode: no model. Crawls every member's read-tool surface and
 * measures what reaches whom.
 */
export type StaticResult = {
  surface: { read: string[]; write: string[]; notCrawled: string[] }
  exposures: Exposure[]
  leaks: Exposure[]
  leakChecks: LeakCheck[]
  knowsReach: KnowsReach[]
  /** Read calls that failed, per tool (e.g. a format that cannot be read yet). */
  toolErrors: Array<{ member: MemberKey; tool: string; error: string }>
}

export async function crawlCompany(company: EvalCompany, f: CompanyFixture): Promise<Crawls> {
  const tz = f.company.timeZone
  const range = {
    from: `${localDateOf(company.anchor, tz, -30)}T00:00:00Z`,
    to: `${localDateOf(company.anchor, tz, 30)}T00:00:00Z`,
    memberIds: f.members.map((m) => m.id),
  }
  const crawls: Crawls = {}
  for (const m of f.members) {
    // Each member's own surface: the brain is offered only what their roles reach (CB3).
    crawls[m.key] = await crawlAsMember((tool, input) => company.exec(m.key, tool, input), company.surfaces[m.key], range)
  }
  return crawls
}

export function surfaceOf(company: EvalCompany): StaticResult['surface'] {
  const offered = new Set(company.surface)
  const descriptors = company.boot.kernel.registry.list().filter((d) => offered.has(d.name))
  const read = descriptors.filter((d) => d.auditClass === 'read').map((d) => d.name).sort()
  const write = descriptors.filter((d) => d.auditClass !== 'read').map((d) => d.name).sort()
  const crawled = new Set<string>(CRAWLED_TOOLS)
  return { read, write, notCrawled: read.filter((t) => !crawled.has(t)) }
}

export function staticResult(f: CompanyFixture, surface: StaticResult['surface'], crawls: Crawls): StaticResult {
  const exp = exposures(f, crawls)
  const toolErrors: StaticResult['toolErrors'] = []
  for (const [member, calls] of Object.entries(crawls) as Array<[MemberKey, CrawlCall[]]>) {
    for (const c of calls) if (!c.ok) toolErrors.push({ member, tool: c.tool, error: c.output.slice(0, 200) })
  }
  return {
    surface,
    exposures: exp,
    leaks: exp.filter((e) => !e.entitled),
    leakChecks: leakChecks(KEEPS.filter((k) => k.kind === 'leak'), crawls),
    knowsReach: knowsReach(KNOWS, crawls),
    toolErrors,
  }
}
