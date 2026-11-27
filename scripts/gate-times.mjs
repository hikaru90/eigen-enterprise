#!/usr/bin/env node
// Where does a push / release spend its time? (npm run gate:times)
//
//   npm run gate:times                 the latest gate run, step by step, plus the slowest spec files
//   npm run gate:times -- --runs 10    the last 10 runs side by side (total per gate)
//   npm run gate:times -- --ci         also the latest GitHub release workflow run, job by job (gh)
//   --run <id>  one run   --brief  steps only (the gates print this when they finish)
//
// Reads <git common dir>/ee-gate/timings.tsv (scripts/gate-step.sh writes it; a step skipped by the
// result cache, scripts/gate-cache.mjs, has `cached:<key>` in its 8th column) and the JSON
// reports the gates leave next to it: vitest-unit.json, vitest-components.json, playwright.json.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return undefined
  const v = args[i + 1]
  if (!v || v.startsWith('--')) throw new Error(`${name} needs a value`)
  return v
}

const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim()
const root = git('rev-parse', '--show-toplevel')
const gateDir = join(git('rev-parse', '--path-format=absolute', '--git-common-dir'), 'ee-gate')
const timingsFile = join(gateDir, 'timings.tsv')

const fmt = (s) => {
  s = Math.round(s)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return m < 60
    ? `${m}m ${String(s % 60).padStart(2, '0')}s`
    : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
const bar = (part, whole, width = 30) =>
  '█'.repeat(whole > 0 ? Math.max(part > 0 ? 1 : 0, Math.round((part / whole) * width)) : 0)

function readRows() {
  if (!existsSync(timingsFile)) return []
  return readFileSync(timingsFile, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [run, commit, gate, step, seconds, exit, at, cached] = line.split('\t')
      return {
        run,
        commit,
        gate,
        step,
        seconds: Number(seconds),
        exit: Number(exit),
        at,
        cached: cached?.startsWith('cached:') ? cached.slice('cached:'.length) : null,
      }
    })
}

function groupRuns(rows) {
  const runs = new Map()
  for (const r of rows) {
    if (!runs.has(r.run)) runs.set(r.run, [])
    runs.get(r.run).push(r)
  }
  return [...runs.entries()].map(([id, steps]) => ({ id, steps }))
}

function printRun(run) {
  const total = run.steps.reduce((a, s) => a + s.seconds, 0)
  const failed = run.steps.find((s) => s.exit !== 0)
  const cached = run.steps.filter((s) => s.cached).length
  const wall =
    (Date.parse(run.steps.at(-1).at) - Date.parse(run.steps[0].at)) / 1000 + run.steps[0].seconds
  console.log(
    `\nGate run ${run.id} on ${run.steps[0].commit}${failed ? `  ✗ failed at ${failed.gate} › ${failed.step}` : ''}`,
  )
  console.log(
    `steps ${fmt(total)}, wall ${fmt(wall)} (the gap is time between gates: hooks, git, docker)${cached ? `, ${cached} cached` : ''}\n`,
  )
  const width = Math.max(...run.steps.map((s) => `${s.gate} › ${s.step}`.length))
  for (const s of run.steps) {
    const label = `${s.gate} › ${s.step}`.padEnd(width)
    if (s.cached) {
      console.log(`  ${label}  ${'cached'.padStart(7)}       green on ${s.cached}`)
      continue
    }
    const pct = total ? `${Math.round((s.seconds / total) * 100)}%`.padStart(4) : ''
    console.log(
      `  ${label}  ${fmt(s.seconds).padStart(7)} ${pct}  ${bar(s.seconds, total)}${s.exit ? '  ✗' : ''}`,
    )
  }
}

function printRuns(runs) {
  const gates = [...new Set(runs.flatMap((r) => r.steps.map((s) => s.gate)))]
  console.log(`\nLast ${runs.length} gate runs (seconds of steps per gate)\n`)
  console.log(
    `  ${'run'.padEnd(24)} ${'commit'.padEnd(12)} ${gates.map((g) => g.padStart(9)).join(' ')}     total`,
  )
  for (const r of runs) {
    const per = gates.map((g) =>
      r.steps.filter((s) => s.gate === g).reduce((a, s) => a + s.seconds, 0),
    )
    const total = per.reduce((a, b) => a + b, 0)
    const fail = r.steps.some((s) => s.exit !== 0) ? ' ✗' : ''
    const hits = r.steps.filter((s) => s.cached).length
    const cachedNote = hits ? `  (${hits} cached)` : ''
    console.log(
      `  ${r.id.padEnd(24)} ${r.steps[0].commit.padEnd(12)} ${per.map((p) => (p ? fmt(p) : '—').padStart(9)).join(' ')} ${fmt(total).padStart(9)}${fail}${cachedNote}`,
    )
  }
}

function reportAge(file) {
  const mins = Math.round((Date.now() - statSync(file).mtimeMs) / 60000)
  return mins < 90 ? `${mins} min ago` : `${Math.round(mins / 60)} h ago`
}

function slowestVitest(name, label) {
  const file = join(gateDir, name)
  if (!existsSync(file)) return
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const files = (report.testResults ?? []).map((t) => ({
    name: relative(root, t.name),
    seconds: (t.endTime - t.startTime) / 1000,
  }))
  printSlowest(
    `${label} — ${files.length} files, run in parallel, so these overlap (${reportAge(file)})`,
    files,
  )
}

function slowestPlaywright() {
  const file = join(gateDir, 'playwright.json')
  if (!existsSync(file)) return
  const report = JSON.parse(readFileSync(file, 'utf8'))
  const perFile = new Map()
  const walk = (suite, fileName) => {
    const f = suite.file ?? fileName
    for (const spec of suite.specs ?? [])
      for (const test of spec.tests ?? [])
        for (const result of test.results ?? [])
          perFile.set(f, (perFile.get(f) ?? 0) + result.duration / 1000)
    for (const child of suite.suites ?? []) walk(child, f)
  }
  for (const suite of report.suites ?? []) walk(suite)
  const files = [...perFile.entries()].map(([name, seconds]) => ({ name, seconds }))
  const wall = (report.stats?.duration ?? 0) / 1000
  printSlowest(
    `e2e (Playwright, 1 worker: these add up) — ${files.length} files, ${fmt(wall)} (${reportAge(file)})`,
    files,
    wall,
  )
}

function printSlowest(title, files, whole) {
  files.sort((a, b) => b.seconds - a.seconds)
  const sum = whole ?? files.reduce((a, f) => a + f.seconds, 0)
  console.log(`\nSlowest ${title}\n`)
  for (const f of files.slice(0, 12))
    console.log(`  ${fmt(f.seconds).padStart(7)}  ${bar(f.seconds, sum, 20).padEnd(20)}  ${f.name}`)
}

function printCi() {
  const gh = (...a) => JSON.parse(execFileSync('gh', a, { encoding: 'utf8', cwd: root }))
  const [latest] = gh(
    'run',
    'list',
    '--workflow',
    'release.yml',
    '-L',
    '1',
    '--json',
    'databaseId,displayTitle,headBranch',
  )
  if (!latest) throw new Error('no release workflow run on GitHub')
  const run = gh('run', 'view', String(latest.databaseId), '--json', 'jobs,createdAt,updatedAt,url')
  const secs = (a, b) => (Date.parse(b) - Date.parse(a)) / 1000
  console.log(
    `\nGitHub release workflow ${latest.headBranch}: ${fmt(secs(run.createdAt, run.updatedAt))}  ${run.url}\n`,
  )
  for (const job of run.jobs) {
    console.log(`  ${job.name}  ${fmt(secs(job.startedAt, job.completedAt))}`)
    for (const s of job.steps ?? []) {
      const t = secs(s.startedAt, s.completedAt)
      if (t >= 5) console.log(`      ${fmt(t).padStart(7)}  ${s.name}`)
    }
  }
}

const rows = readRows()
const runs = groupRuns(rows)
if (!runs.length && !flag('--ci')) {
  console.log(
    `No gate timings yet (${timingsFile}). They are recorded from the next npm run push / ci:local / test:e2e.`,
  )
  process.exit(0)
}
if (value('--runs')) {
  printRuns(runs.slice(-Number(value('--runs'))))
} else if (runs.length) {
  const id = value('--run')
  const run = id ? runs.find((r) => r.id === id) : runs.at(-1)
  if (!run) throw new Error(`no gate run ${id} in ${timingsFile}`)
  printRun(run)
  if (!flag('--brief')) {
    slowestVitest('vitest-unit.json', 'unit specs')
    slowestVitest('vitest-components.json', 'component specs')
    slowestPlaywright()
  }
}
if (flag('--ci')) printCi()
console.log()
