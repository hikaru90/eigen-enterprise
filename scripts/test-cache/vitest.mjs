#!/usr/bin/env node
// Test cache for Vitest (scripts/test-cache/README.md). Runs only the spec files a change can
// affect since this suite last passed on a clean tree:
//   node scripts/test-cache/vitest.mjs <unit|components> [-- <vitest run args …>]
// Affected = Vitest's own import graph (`vitest list --changed <base>`) plus, for unit, the specs
// that read, list or run the changed files (recorded by vitest-record.ts). Toolchain, schema and
// message changes, a missing record and EE_GATE_FULL=1 run the whole suite.
import { execFileSync, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { globalTrigger, mergeUnitDeps, selectUnitExtras } from './core.mjs'
import { changedSince, forcedFull, head, isCommit, noteSelection, readJsonl, readState, root, treeClean, writeState } from './lib.mjs'

const suite = process.argv[2]
const configs = { unit: 'vitest.config.ts', components: 'vitest.browser.config.ts' }
const config = configs[suite]
if (!config) {
  console.error('usage: scripts/test-cache/vitest.mjs <unit|components> [-- <vitest args>]')
  process.exit(2)
}
const dash = process.argv.indexOf('--')
const passthrough = dash === -1 ? [] : process.argv.slice(dash + 1)
const vitest = path.join(root, 'node_modules', '.bin', 'vitest')
const log = (m) => console.log(`test-cache › ${suite}: ${m}`)

if (suite === 'components') execFileSync('node', ['scripts/patch-vitest-browser-iframeid.mjs'], { cwd: root, stdio: 'inherit' })

const startHead = head()
const state = readState(suite)
/** @type {{ files: string[] | null, reason: string, base: string | null }} */
const plan = choose()

function choose() {
  if (forcedFull()) return { files: null, reason: 'full run asked for (EE_GATE_FULL=1)', base: null }
  if (!state?.base || !isCommit(state.base)) return { files: null, reason: 'no green run recorded yet', base: null }
  const changed = changedSince(state.base)
  for (const c of changed) {
    const g = globalTrigger(suite, c)
    if (g) return { files: null, reason: g, base: state.base }
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-test-cache-'))
  const listed = path.join(tmp, 'list.json')
  const r = spawnSync(vitest, ['list', '--config', config, '--changed', state.base, '--filesOnly', `--json=${listed}`], {
    cwd: root,
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  if (r.status !== 0) {
    console.error(`test-cache › ${suite}: vitest list failed (exit ${r.status}); refusing to guess which specs to skip`)
    process.exit(r.status ?? 1)
  }
  const fromGraph = JSON.parse(fs.readFileSync(listed, 'utf8')).map((e) => path.relative(root, e.file))
  fs.rmSync(tmp, { recursive: true, force: true })
  const extras = suite === 'unit' ? [...selectUnitExtras({ changed, deps: state.deps ?? {} })] : []
  const files = [...new Set([...fromGraph, ...extras])].filter((f) => fs.existsSync(path.join(root, f))).sort()
  const extra = extras.filter((f) => !fromGraph.includes(f)).length
  return {
    files,
    reason: `${changed.length} changed file(s) since ${state.base.slice(0, 12)}${extra ? ` (${extra} spec(s) read or run them)` : ''}`,
    base: state.base,
  }
}

if (plan.files && plan.files.length === 0) {
  log(`nothing to run: no spec file can see the ${plan.reason}`)
  noteSelection({ suite, base: plan.base, selected: 0, total: '', reason: plan.reason })
  stamp({})
  process.exit(0)
}
log(plan.files ? `${plan.files.length} spec file(s): ${plan.reason}` : `all spec files: ${plan.reason}`)
noteSelection({ suite, base: plan.base, selected: plan.files ? plan.files.length : 'all', total: '', reason: plan.reason })

const depsDir = suite === 'unit' ? fs.mkdtempSync(path.join(os.tmpdir(), 'ee-test-deps-')) : null
const run = spawnSync(vitest, ['run', '--config', config, ...passthrough, ...(plan.files ?? [])], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, ...(depsDir ? { EE_TEST_DEPS_DIR: depsDir } : {}) },
})
if (run.status === 0) {
  /** @type {Record<string, unknown>} */
  const ran = {}
  if (depsDir) for (const { spec, ...d } of readJsonl(depsDir, 'unit-')) ran[spec] = d
  stamp(ran)
}
if (depsDir) fs.rmSync(depsDir, { recursive: true, force: true })
process.exit(run.status ?? 1)

/** A green run vouches for HEAD only when HEAD did not move and nothing was uncommitted. */
function stamp(ran) {
  if (head() !== startHead) return log('HEAD moved during the run; not recording it')
  if (!treeClean()) return log('uncommitted changes; this run is not recorded (the next run compares with the last clean one)')
  const deps = plan.files === null ? ran : mergeUnitDeps(state?.deps ?? {}, ran)
  writeState(suite, { base: startHead, deps, at: new Date().toISOString() })
}
