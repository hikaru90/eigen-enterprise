import type { ItemResult } from './grade'
import type { StaticResult } from './static'
import { describe, expect, it } from 'vitest'
import { buildReport, reportFileStem, summarize, toMarkdown } from './report'

const item = (over: Partial<ItemResult>): ItemResult => ({
  id: 'X',
  suite: 'knows',
  layer: 'understand',
  concept: 'c',
  asker: 'martin',
  prompt: '?',
  pass: true,
  graded: 'judge',
  detail: {},
  error: null,
  reply: '',
  tools: [],
  approvals: [],
  ...over,
})

const STATIC: StaticResult = {
  surface: { read: ['drive.read'], write: ['drive.write_text'], notCrawled: [] },
  exposures: [],
  leaks: [{ member: 'jonas', sourceId: 'drive-ony-salary', entitled: false, tools: ['drive.read'] }],
  leakChecks: [
    { id: 'L01', asker: 'martin', pass: true, leaked: [] },
    { id: 'L06', asker: 'jonas', pass: false, leaked: ['drive-ony-salary'] },
  ],
  knowsReach: [{ id: 'K01', asker: 'martin', reachable: false, reached: [], missing: ['call-acme'] }],
  toolErrors: [],
}

describe('the eval report', () => {
  it('scores each suite on graded items only, and splits Keeps into leak and judgment', () => {
    const s = summarize([
      item({ id: 'K1', pass: true }),
      item({ id: 'K2', pass: false }),
      item({ id: 'K3', pass: null, graded: 'not_graded' }),
      item({ id: 'L1', suite: 'keeps', kind: 'leak', pass: true }),
      item({ id: 'J1', suite: 'keeps', kind: 'judgment', pass: false }),
    ])
    expect(s.knows).toEqual({ total: 3, graded: 2, passed: 1, score: 0.5 })
    expect(s.keeps).toEqual({ total: 2, graded: 2, passed: 1, score: 0.5 })
    expect(s.keepsLeak).toEqual({ total: 1, graded: 1, passed: 1, score: 1 })
    expect(s.keepsJudgment).toEqual({ total: 1, graded: 1, passed: 0, score: 0 })
    expect(s.does).toEqual({ total: 0, graded: 0, passed: 0, score: null })
  })

  it('a static (no-model) report carries the tool-level scores', () => {
    const r = buildReport({ mode: 'static', provider: 'none', sha: 'abc1234', date: '2026-11-20', anchor: new Date('2026-11-20T10:00:00Z'), items: [], static: STATIC, cost: null, notes: [] })
    expect(r.staticSummary).toEqual({ leaksAtToolLevel: 1, leakChecks: { passed: 1, total: 2 }, knowsReachable: { reachable: 0, total: 1 } })
    expect(reportFileStem(r)).toBe('2026-11-20-abc1234-static')
  })

  it('the markdown says what was measured and what was not', () => {
    const r = buildReport({ mode: 'static', provider: 'none', sha: 'abc1234', date: '2026-11-20', anchor: new Date('2026-11-20T10:00:00Z'), items: [], static: STATIC, cost: null, notes: ['baseline not measured: no provider'] })
    const md = toMarkdown(r)
    expect(md).toContain('# Brain eval — 2026-11-20 abc1234 (static)')
    expect(md).toContain('Leak tests at tool level: 1/2 pass')
    expect(md).toContain('jonas ← drive-ony-salary (drive.read)')
    expect(md).toContain('baseline not measured: no provider')
  })
})
