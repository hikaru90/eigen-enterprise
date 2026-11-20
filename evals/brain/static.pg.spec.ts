import type { EvalCompany } from './harness'
import type { StaticResult } from './static'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KNOWN_REACHABLE_KNOWS, KNOWN_TOOL_LEAKS } from './baseline'
import { listSources } from './fixture/audience'
import { COMPANY } from './fixture/company'
import { DOES } from './suites'

/**
 * The north-star eval's deterministic half in the unit gate: the fixture is
 * seeded through the real services into its own database on the test
 * Postgres (:5433, `npm run db:up`), the real app is booted, and every
 * member's read-tool surface is crawled the way a chat turn calls tools. No
 * model. Needs DATABASE_URL like the other *.pg.spec.ts; skipped without it
 * (`npm run eval:brain` runs the same check standalone and loads .env).
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('north-star eval, tool level (seeded company, real boot, no model)', () => {
  let company: EvalCompany
  let result: StaticResult

  beforeAll(async () => {
    const { setUpEvalCompany } = await import('./harness')
    const { crawlCompany, staticResult, surfaceOf } = await import('./static')
    company = await setUpEvalCompany(COMPANY, { anchor: new Date(), enrichThoughts: false, databaseName: `ee_eval_brain_gate_${process.pid}` })
    result = staticResult(COMPANY, surfaceOf(company), await crawlCompany(company, COMPANY))
  }, 180_000)

  afterAll(async () => {
    await company?.tearDown({ dropDatabase: true })
  }, 60_000)

  it('the whole fixture was seeded (every source has its product row)', () => {
    for (const s of listSources(COMPANY)) expect(company.seeded.ids.has(s.id), s.id).toBe(true)
  })

  it('the brain is offered read tools for every module the fixture fills', () => {
    for (const tool of ['messages.read', 'drive.read', 'memory.retrieve_thoughts', 'calls.list', 'calendar.list', 'contacts.list']) {
      expect(result.surface.read).toContain(tool)
    }
  })

  it('no content reaches anyone beyond the recorded baseline (a fixed leak must be struck from baseline.ts)', () => {
    const leaks = result.leaks.map((l) => `${l.member} ← ${l.sourceId}`).sort()
    expect(leaks).toEqual([...KNOWN_TOOL_LEAKS].sort())
  })

  it('every member still reaches what the baseline says they reach for Knows', () => {
    expect(result.knowsReach.filter((k) => k.reachable).map((k) => k.id).sort()).toEqual([...KNOWN_REACHABLE_KNOWS].sort())
  })

  it('DMs, the mailbox, the call transcript and private thoughts reach no one who may not read them', () => {
    const kinds = new Map(listSources(COMPANY).map((s) => [s.id, s.kind]))
    const strict = result.leaks.filter((l) => ['dm_message', 'mail', 'call', 'thought'].includes(kinds.get(l.sourceId) ?? ''))
    expect(strict).toEqual([])
  })

  // Last: these change the company. Each Does check must see nothing before its task and the task after it.
  for (const item of DOES) {
    it(`Does ${item.id}: the ${item.state.check} check sees the task only once it is done`, async () => {
      const { checkState, dbNow } = await import('./state')
      const { performDoesTask } = await import('./oracle')
      const since = await dbNow()
      const ctx = { f: COMPANY, seeded: company.seeded, since, anchor: company.anchor }
      expect((await checkState(item.state, ctx)).done).toBe(false)
      await performDoesTask(item, company, COMPANY)
      expect((await checkState(item.state, ctx)).done).toBe(true)
    })
  }
})
