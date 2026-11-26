#!/usr/bin/env node
// Test cache for browser e2e (scripts/test-cache/README.md), used by the release gate:
//   node scripts/test-cache/e2e.mjs
// Runs only the e2e files whose recorded code changed since the e2e suite last passed on a
// clean tree, records what each file ran this time (EE_E2E_DEPS=1), and on green stores the
// new map. Harness, toolchain, schema and message changes, code that runs at server start, a
// missing map and EE_GATE_FULL=1 run every file.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { emptyE2eMap, mergeE2eMap, selectE2e } from './core.mjs'
import { changedSince, forcedFull, head, isCommit, noteSelection, readJsonl, readState, root, treeClean, writeState } from './lib.mjs'

const log = (m) => console.log(`test-cache › e2e: ${m}`)
const e2eDir = path.join(root, 'src', 'routes', 'e2e')
const allE2e = fs
  .readdirSync(e2eDir)
  .filter((f) => f.endsWith('.e2e.ts'))
  .map((f) => `src/routes/e2e/${f}`)
  .sort()

const startHead = head()
const state = readState('e2e')
const usable = state?.base && isCommit(state.base) ? state : null
const full = forcedFull() || !usable
const changed = usable ? changedSince(usable.base) : []
const sel = forcedFull()
  ? { all: true, reason: 'full run asked for (EE_GATE_FULL=1)', files: allE2e, why: {} }
  : selectE2e({ changed, allE2e, map: usable?.map ?? null })

if (!sel.all && sel.files.length === 0) {
  log(`nothing to run: no e2e file ran any of the ${changed.length} changed file(s) since ${usable.base.slice(0, 12)}`)
  noteSelection({ suite: 'e2e', base: usable.base, selected: 0, total: allE2e.length, reason: `${changed.length} changed file(s)` })
  stamp(null)
  process.exit(0)
}
if (sel.all) log(`all ${allE2e.length} files: ${sel.reason}`)
else {
  log(`${sel.files.length} of ${allE2e.length} files (${changed.length} changed file(s) since ${usable.base.slice(0, 12)}):`)
  for (const f of sel.files) console.log(`  ${path.basename(f)} — ${sel.why[f]}`)
}
noteSelection({
  suite: 'e2e',
  base: usable?.base ?? null,
  selected: sel.all ? 'all' : sel.files.length,
  total: allE2e.length,
  reason: sel.all ? sel.reason : `${changed.length} changed file(s)`,
})

const out = fs.mkdtempSync(path.join(os.tmpdir(), 'ee-e2e-deps-'))
const run = spawnSync(path.join(root, 'scripts', 'e2e.sh'), ['--pass-with-no-tests', ...(sel.all ? [] : sel.files)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, EE_E2E_DEPS: '1', EE_E2E_DEPS_OUT: out },
})
if (run.status === 0) stamp(collect())
fs.rmSync(out, { recursive: true, force: true })
process.exit(run.status ?? 1)

function collect() {
  /** @type {Record<string, Set<string>>} */
  const tests = {}
  // A file that ran but recorded nothing (all its tests skipped here) touched nothing.
  for (const f of sel.files) tests[f] = new Set()
  for (const { file, files } of readJsonl(out, 'raw')) {
    const set = (tests[file] ??= new Set())
    for (const f of files) set.add(f)
  }
  const read = (name) => {
    const p = path.join(out, name)
    if (!fs.existsSync(p)) throw new Error(`test-cache › e2e: the run left no ${name}; not recording it`)
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  }
  const startup = read('startup.json')
  const graph = read('graph.json')
  return {
    tests: Object.fromEntries(Object.entries(tests).map(([k, v]) => [k, [...v].sort()])),
    startup: startup.inner,
    importers: graph.importers,
    inner: [...new Set([...graph.inner, ...startup.inner])].sort(),
    seen: graph.seen,
  }
}

/** A green run vouches for HEAD only when HEAD did not move and nothing was uncommitted. */
function stamp(ranRecord) {
  if (head() !== startHead) return log('HEAD moved during the run; not recording it')
  if (!treeClean()) return log('uncommitted changes; this run is not recorded')
  const base = full ? emptyE2eMap() : usable.map
  const map = ranRecord ? mergeE2eMap(base, ranRecord) : base
  writeState('e2e', { base: startHead, map, at: new Date().toISOString() })
}
