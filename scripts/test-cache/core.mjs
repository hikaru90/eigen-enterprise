// Test cache, pure part (scripts/test-cache/README.md): which tests a change can affect.
// Everything here is data in, data out; git and the file system live in lib.mjs.
import path from 'node:path'

/** Changes that can affect any test: the toolchain, the schema, the messages, the cache itself. */
const EVERYWHERE = [
  /^package(-lock)?\.json$/,
  /^(vite|vitest|vitest\.browser|playwright)\.config\.[cm]?[jt]s$/,
  /^vitest\.global-(setup|teardown)\.ts$/,
  /^svelte\.config\.[cm]?js$/,
  /^tsconfig(\..+)?\.json$/,
  /^\.npmrc$/,
  /^drizzle\//,
  /^messages\//,
  /^project\.inlang\/settings\.json$/,
  /^vendor\//,
  /^scripts\/test-cache\//,
  /^scripts\/patch-vitest-browser-iframeid\.mjs$/,
]

/** Browser e2e only: the harness, mock services and files the server sends as they are. */
const E2E_EVERYWHERE = [
  /^src\/routes\/e2e\/(?!.*\.e2e\.ts$)/, // helpers, fixtures, the fixture-wrapped `test`
  /^scripts\/mock-/,
  /^scripts\/(e2e|tag-gate|release)\.sh$/,
  /^scripts\/(migrate|ensure-[^/]+|apply-rls|db-urls|load-env|env-file|e2e-databases)\.mjs$/,
  /^static\//,
  /^src\/app\.(html|d\.ts)$/,
  /^src\/service-worker/,
]

/**
 * Why `file` re-runs the whole suite, or null.
 * @param {'unit'|'components'|'e2e'} suite
 * @param {string} file repo-relative
 */
export function globalTrigger(suite, file) {
  if (EVERYWHERE.some((re) => re.test(file))) return `${file} can affect every test`
  if (suite === 'e2e' && E2E_EVERYWHERE.some((re) => re.test(file))) return `${file} is part of the e2e harness`
  return null
}

/**
 * Unit specs whose result depends on files they read, list or run rather than import
 * (the import graph Vitest's `--changed` follows does not see those).
 * @param {{ changed: string[], deps: Record<string, { reads?: string[], dirs?: string[], recursiveDirs?: string[], spawnRepo?: boolean, spawnTmp?: boolean }> }} input
 * @returns {Set<string>}
 */
export function selectUnitExtras({ changed, deps }) {
  const out = new Set()
  for (const [spec, d] of Object.entries(deps)) {
    if (d.spawnRepo && changed.length > 0) {
      out.add(spec)
      continue
    }
    const reads = new Set(d.reads ?? [])
    const dirs = new Set(d.dirs ?? [])
    const rec = d.recursiveDirs ?? []
    for (const c of changed) {
      const dir = path.posix.dirname(c)
      if (
        reads.has(c) ||
        dirs.has(dir) ||
        rec.some((r) => c.startsWith(`${r}/`)) ||
        (d.spawnTmp && /^(scripts|ee|bin)\//.test(c))
      ) {
        out.add(spec)
        break
      }
    }
  }
  return out
}

/**
 * The changed files plus the code that can observe them without running their functions:
 * direct importers always (a changed constant is read there), and on through importers that
 * never ran code of their own in a recorded run (re-export barrels, constant modules).
 * @param {string[]} changed
 * @param {Record<string, string[]>} importers
 * @param {string[]} inner files with a non-module-level function that ran
 */
export function expandChanged(changed, importers, inner) {
  const ran = new Set(inner)
  const out = new Set(changed)
  const queue = [...changed]
  while (queue.length > 0) {
    const file = /** @type {string} */ (queue.shift())
    for (const imp of importers[file] ?? []) {
      if (out.has(imp)) continue
      out.add(imp)
      if (!ran.has(imp)) queue.push(imp)
    }
  }
  return out
}

/** @returns {{ tests: Record<string, string[]>, startup: string[], importers: Record<string, string[]>, inner: string[] }} */
export function emptyE2eMap() {
  return { tests: {}, startup: [], importers: {}, inner: [] }
}

/**
 * Which e2e files to run for `changed`, given the map recorded at the last green run.
 * @param {{ changed: string[], allE2e: string[], map: ReturnType<typeof emptyE2eMap> | null }} input
 * @returns {{ all: boolean, reason: string, files: string[], why: Record<string, string> }}
 */
export function selectE2e({ changed, allE2e, map }) {
  const all = (reason) => ({ all: true, reason, files: [...allE2e], why: {} })
  if (!map) return all('no recorded run to compare with')
  for (const c of changed) {
    const g = globalTrigger('e2e', c)
    if (g) return all(g)
  }
  const touched = expandChanged(changed, map.importers, map.inner)
  const startup = new Set(map.startup)
  for (const t of touched) if (startup.has(t)) return all(`${t} runs when the server starts`)
  /** @type {Record<string, string>} */
  const why = {}
  const changedSet = new Set(changed)
  for (const file of allE2e) {
    const rec = map.tests[file]
    if (changedSet.has(file)) why[file] = 'the test file changed'
    else if (!rec) why[file] = 'no recorded run of this file'
    else {
      const hit = rec.find((f) => touched.has(f))
      if (hit) why[file] = `it ran ${hit}`
    }
  }
  return { all: false, reason: '', files: allE2e.filter((f) => why[f]), why }
}

/**
 * The map after a green run: files that ran get this run's record, the rest keep theirs.
 * @param {ReturnType<typeof emptyE2eMap>} old
 * @param {{ tests: Record<string, string[]>, startup: string[], importers: Record<string, string[]>, inner: string[], seen: string[] }} run
 */
export function mergeE2eMap(old, run) {
  const importers = { ...old.importers }
  for (const [file, imps] of Object.entries(run.importers)) {
    importers[file] = [...new Set([...(importers[file] ?? []), ...imps])].sort()
  }
  const seen = new Set(run.seen)
  const inner = new Set(old.inner.filter((f) => !seen.has(f)))
  for (const f of run.inner) inner.add(f)
  return {
    tests: { ...old.tests, ...run.tests },
    startup: [...run.startup],
    importers,
    inner: [...inner].sort(),
  }
}

/**
 * @template T
 * @param {Record<string, T>} old
 * @param {Record<string, T>} ran
 */
export function mergeUnitDeps(old, ran) {
  return { ...old, ...ran }
}
