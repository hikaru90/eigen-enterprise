import type { ItemResult } from './grade'
import type { StaticResult } from './static'
import { JUDGE_ENGINE } from './judge'

/**
 * evals/reports/brain/<date>-<sha>-<mode>.json + .md. Items carry the
 * brain's reply (fixture data only — the fixture holds no secrets) and the
 * tool names it called; never provider credentials or env values.
 */

export type SuiteSummary = { total: number; graded: number; passed: number; score: number | null }
export type Summary = { knows: SuiteSummary; does: SuiteSummary; keeps: SuiteSummary; keepsLeak: SuiteSummary; keepsJudgment: SuiteSummary }
export type Cost = { brainUsd: number; judgeUsd: number; totalUsd: number; calls: number }

export type BrainReport = {
  schema: 1
  date: string
  sha: string
  mode: 'static' | 'chat'
  provider: string
  anchor: string
  judgeEngine: string
  summary: Summary
  staticSummary: { leaksAtToolLevel: number; leakChecks: { passed: number; total: number }; knowsReachable: { reachable: number; total: number } }
  cost: Cost | null
  notes: string[]
  static: StaticResult
  items: ItemResult[]
}

function suite(items: ItemResult[]): SuiteSummary {
  const graded = items.filter((i) => i.pass !== null)
  const passed = graded.filter((i) => i.pass === true).length
  return { total: items.length, graded: graded.length, passed, score: graded.length > 0 ? passed / graded.length : null }
}

export function summarize(items: ItemResult[]): Summary {
  return {
    knows: suite(items.filter((i) => i.suite === 'knows')),
    does: suite(items.filter((i) => i.suite === 'does')),
    keeps: suite(items.filter((i) => i.suite === 'keeps')),
    keepsLeak: suite(items.filter((i) => i.suite === 'keeps' && i.kind === 'leak')),
    keepsJudgment: suite(items.filter((i) => i.suite === 'keeps' && i.kind === 'judgment')),
  }
}

export function buildReport(input: {
  mode: BrainReport['mode']
  provider: string
  sha: string
  date: string
  anchor: Date
  items: ItemResult[]
  static: StaticResult
  cost: Cost | null
  notes: string[]
}): BrainReport {
  const s = input.static
  return {
    schema: 1,
    date: input.date,
    sha: input.sha,
    mode: input.mode,
    provider: input.provider,
    anchor: input.anchor.toISOString(),
    judgeEngine: JUDGE_ENGINE,
    summary: summarize(input.items),
    staticSummary: {
      leaksAtToolLevel: s.leaks.length,
      leakChecks: { passed: s.leakChecks.filter((c) => c.pass).length, total: s.leakChecks.length },
      knowsReachable: { reachable: s.knowsReach.filter((k) => k.reachable).length, total: s.knowsReach.length },
    },
    cost: input.cost,
    notes: input.notes,
    static: s,
    items: input.items,
  }
}

export const reportFileStem = (r: BrainReport) => `${r.date}-${r.sha}-${r.mode}`

const pct = (s: SuiteSummary) => (s.score === null ? 'not graded' : `${s.passed}/${s.graded} (${Math.round(s.score * 100)}%)${s.graded < s.total ? `, ${s.total - s.graded} not graded` : ''}`)

export function toMarkdown(r: BrainReport): string {
  const s = r.staticSummary
  const lines = [
    `# Brain eval — ${r.date} ${r.sha} (${r.mode})`,
    '',
    `Provider: ${r.provider}. Anchor: ${r.anchor}. Judge: ${r.judgeEngine}.`,
    '',
    ...r.notes.map((n) => `> ${n}`),
    ...(r.notes.length ? [''] : []),
    '## Tool level (no model)',
    '',
    `- Leak tests at tool level: ${s.leakChecks.passed}/${s.leakChecks.total} pass`,
    `- Knows sources reachable through the brain's tools: ${s.knowsReachable.reachable}/${s.knowsReachable.total}`,
    `- Content reaching someone not entitled to it: ${s.leaksAtToolLevel}`,
    ...r.static.leaks.map((l) => `  - ${l.member} ← ${l.sourceId} (${l.tools.join(', ')})`),
    `- Read tools offered: ${r.static.surface.read.length}; write tools: ${r.static.surface.write.length}; read tools not crawled: ${r.static.surface.notCrawled.length}`,
    ...[...new Set(r.static.toolErrors.map((e) => `${e.tool}: ${e.error}`))].map((e) => `  - error: ${e}`),
  ]
  if (r.mode === 'chat') {
    lines.push(
      '',
      '## Chat (real chat path)',
      '',
      `- Knows: ${pct(r.summary.knows)}`,
      `- Does: ${pct(r.summary.does)}`,
      `- Keeps: ${pct(r.summary.keeps)} — leak ${pct(r.summary.keepsLeak)}, judgment ${pct(r.summary.keepsJudgment)}`,
      ...(r.cost ? [`- Cost: $${r.cost.totalUsd.toFixed(4)} (brain $${r.cost.brainUsd.toFixed(4)}, judge $${r.cost.judgeUsd.toFixed(4)}, ${r.cost.calls} gateway calls)`] : []),
      '',
      '| item | suite | layer | asker | pass | note |',
      '|---|---|---|---|---|---|',
      ...r.items.map((i) => `| ${i.id} | ${i.suite}${i.kind ? `/${i.kind}` : ''} | ${i.layer} | ${i.asker} | ${i.pass === null ? '—' : i.pass ? 'yes' : 'no'} | ${(i.error ?? JSON.stringify(i.detail)).replace(/\|/g, '/').slice(0, 120)} |`),
    )
  }
  return `${lines.join('\n')}\n`
}
