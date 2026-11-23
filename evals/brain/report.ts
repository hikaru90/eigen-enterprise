import type { CoworkersResult } from './coworkers/suite'
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
/** `coworkersUsd`: the AI co-workers' own turns (and their thoughts' enrichment), billed to their own user ids. */
export type Cost = { brainUsd: number; judgeUsd: number; coworkersUsd: number; totalUsd: number; calls: number }

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
  /** The AI co-workers suite (C8); null when not run. */
  coworkers: CoworkersResult | null
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
  coworkers?: CoworkersResult | null
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
    coworkers: input.coworkers ?? null,
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
      ...(r.cost ? [`- Cost: $${r.cost.totalUsd.toFixed(4)} (brain $${r.cost.brainUsd.toFixed(4)}, judge $${r.cost.judgeUsd.toFixed(4)}, co-workers $${r.cost.coworkersUsd.toFixed(4)}, ${r.cost.calls} gateway calls)`] : []),
      '',
      '| item | suite | layer | asker | pass | note |',
      '|---|---|---|---|---|---|',
      ...r.items.map((i) => `| ${i.id} | ${i.suite}${i.kind ? `/${i.kind}` : ''} | ${i.layer} | ${i.asker} | ${i.pass === null ? '—' : i.pass ? 'yes' : 'no'} | ${(i.error ?? JSON.stringify(i.detail)).replace(/\|/g, '/').slice(0, 120)} |`),
    )
  }
  if (r.coworkers) lines.push('', ...coworkersMarkdown(r.coworkers))
  return `${lines.join('\n')}\n`
}

const mark = (pass: boolean) => (pass ? 'pass' : 'FAIL')

/** The co-workers suite (C8) in a few lines: every part says pass, FAIL or why it was skipped. */
export function coworkersMarkdown(c: CoworkersResult): string[] {
  const k = c.keeps
  const lines = [
    '## Co-workers (C8)',
    '',
    `- Keeps: leak tests ${k.leaks.filter((l) => l.pass).length}/${k.leaks.length} pass; reach ${k.reach.filter((x) => x.pass).length}/${k.reach.length} pass; their thoughts read-only to people: ${mark(k.readOnly.pass && k.writeProbe.pass)}`,
    ...k.leaks.filter((l) => !l.pass).map((l) => `  - FAIL ${l.id} ${l.concept}: ${l.leaked.map((x) => `${x.coworker} ← ${x.sourceId} (${x.tools.join(', ')})`).join('; ')}`),
    ...k.reach.filter((x) => !x.pass).map((x) => `  - FAIL ${x.id} ${x.concept}: missing ${x.missing.map((m) => `${m.seat} → ${m.sourceId}`).join('; ')}`),
    ...k.readOnly.wrong.map((v) => `  - FAIL read-only view: ${v.member} gets ${v.sourceId} with owner ${String(v.ownerKind)}, editable ${String(v.editable)}`),
    ...k.writeProbe.probes.filter((p) => !p.refused).map((p) => `  - FAIL write probe: ${p.as} (${p.via}) was not refused changing a co-worker's thought`),
    ...(k.writeProbe.unchanged ? [] : ["  - FAIL write probe: the co-worker's thought changed"]),
  ]
  if ('skipped' in c.does) lines.push(`- Does: ${c.does.skipped}`)
  else {
    const checks = c.does.checks
    lines.push(`- Does: ${checks.filter((x) => x.pass).length}/${checks.length} pass (${checks.map((x) => `${x.id} ${x.concept} ${mark(x.pass)}`).join(', ')})`)
    for (const x of checks.filter((y) => !y.pass)) lines.push(`  - FAIL ${x.id}: ${JSON.stringify(x.detail).slice(0, 300)}`)
  }
  if ('skipped' in c.different) lines.push(`- Different: ${c.different.skipped}`)
  else {
    const d = c.different
    const pairs = d.pairwiseCosine.map((p) => `${p.a}/${p.b} ${p.cosine.toFixed(3)}`).join(', ')
    lines.push(`- Different: ${mark(d.pass)}, max pairwise cosine ${d.maxPairwiseCosine.toFixed(3)} (threshold ${d.threshold}; ${pairs}); Jev judge: ${d.jevJudge.status} (CB2)`)
  }
  return lines
}
