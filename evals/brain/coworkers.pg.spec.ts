import type { ScriptedGateway } from './coworkers/gateway'
import type { CoworkersResult } from './coworkers/suite'
import type { EvalCompany } from './harness'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { COWORKER_DOES_PASSING, COWORKER_KEEPS_FAILING } from './baseline'
import { COMPANY } from './fixture/company'
import { validateCoworkerSuite } from './suites/coworkers'

/**
 * The co-workers suite (C8) in the unit gate: the seeded company with its
 * three AI co-workers, the real boot, the tool-level crawl as every seat, and
 * the co-workers' real turns (the Messages trigger, the turn queue, the
 * durable engine, the gateway, the cost log) against the scripted model — no
 * upstream, so a request no script answers fails the turn. Its own database
 * on the test Postgres (:5433); skipped without DATABASE_URL.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('north-star eval, AI co-workers (seeded company, real boot, scripted model)', () => {
  let company: EvalCompany
  let gateway: ScriptedGateway
  let result: CoworkersResult

  beforeAll(async () => {
    const { startScriptedGateway } = await import('./coworkers/gateway')
    gateway = await startScriptedGateway({ upstream: null })
    const { providerEnvFor } = await import('./cli')
    const { setUpEvalCompany } = await import('./harness')
    const { crawlCompany } = await import('./static')
    const { runCoworkersSuite } = await import('./coworkers/suite')
    company = await setUpEvalCompany(COMPANY, {
      anchor: new Date(),
      enrichThoughts: false,
      env: providerEnvFor('mock', {}, gateway.origin),
      databaseName: `ee_eval_brain_cw_${process.pid}`,
    })
    result = await runCoworkersSuite(company, COMPANY, await crawlCompany(company, COMPANY), { kind: 'mock', gateway })
  }, 240_000)

  afterAll(async () => {
    await company?.tearDown({ dropDatabase: true })
    await gateway?.close()
  }, 60_000)

  it('the suite is valid against the fixture', () => {
    expect(validateCoworkerSuite(COMPANY)).toEqual([])
  })

  it('Keeps: no co-worker reaches a private item beyond the recorded baseline (a fixed one must be struck from baseline.ts)', () => {
    expect(result.keeps.leaks.filter((l) => !l.pass).map((l) => l.id)).toEqual([...COWORKER_KEEPS_FAILING])
  })

  it('Keeps: private thoughts, DMs, mailboxes, private channels and calls reach no co-worker — through any hand', () => {
    const strict = result.keeps.leaks.filter((l) => ['CK01', 'CK02', 'CK03', 'CK04', 'CK07', 'CK08'].includes(l.id))
    expect(strict.flatMap((l) => l.leaked)).toEqual([])
  })

  it('Keeps: what is shared with a co-worker reaches it, and its thoughts reach everyone', () => {
    expect(result.keeps.reach.flatMap((r) => r.missing)).toEqual([])
  })

  it('Keeps: people get a co-worker’s thoughts read-only and cannot change them (as themselves or through the brain)', () => {
    expect(result.keeps.readOnly.wrong).toEqual([])
    expect(result.keeps.readOnly.views.length).toBeGreaterThan(0)
    expect(result.keeps.writeProbe.probes.filter((p) => !p.refused)).toEqual([])
    expect(result.keeps.writeProbe.unchanged).toBe(true)
  })

  it('Does: the three-co-worker launch and the thread budget, graded on the state they leave', () => {
    if ('skipped' in result.does) throw new Error(`Does was skipped: ${result.does.skipped}`)
    const failed = result.does.checks.filter((c) => !c.pass)
    expect(failed).toEqual([])
    expect(result.does.checks.map((c) => c.id)).toEqual([...COWORKER_DOES_PASSING])
  })

  it('Different is skipped with a visible reason without real models', () => {
    expect(result.different).toEqual({ skipped: expect.stringContaining('needs real models') })
  })
})
