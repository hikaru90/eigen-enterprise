// Test cache (scripts/test-cache/README.md): a Vitest setup file, loaded only when the gate
// records (EE_TEST_DEPS_DIR). It notes the repo files each spec file reads, lists or runs —
// what Vitest's import graph cannot see — so a change to such a file re-runs that spec.
import cp from 'node:child_process'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, expect } from 'vitest'

type Rec = { reads: Set<string>; dirs: Set<string>; recursiveDirs: Set<string>; spawnRepo: boolean; spawnTmp: boolean }
type G = typeof globalThis & { __eeTestDeps?: { rec: Rec; installed: boolean; appendFileSync: typeof fs.appendFileSync } }

const out = process.env.EE_TEST_DEPS_DIR
const root = fs.realpathSync(process.cwd())
const g = globalThis as G
// Our own checks must not count as the spec's reads.
const exists = fs.existsSync

function rel(p: unknown): string | null {
  let s: string
  if (typeof p === 'string') s = p
  else if (p instanceof URL && p.protocol === 'file:') s = fileURLToPath(p)
  else if (Buffer.isBuffer(p)) s = p.toString()
  else return null
  const abs = path.resolve(s)
  if (!abs.startsWith(`${root}/`)) return null
  const r = abs.slice(root.length + 1)
  if (/(^|\/)(node_modules|\.git|\.svelte-kit|test-results|coverage|build|dist)(\/|$)/.test(r)) return null
  return r
}

function fresh(): Rec {
  return { reads: new Set(), dirs: new Set(), recursiveDirs: new Set(), spawnRepo: false, spawnTmp: false }
}

function install(): void {
  const st = g.__eeTestDeps as NonNullable<G['__eeTestDeps']>
  const read = (p: unknown) => {
    const r = rel(p)
    if (r) st.rec.reads.add(r)
  }
  const list = (p: unknown, opts: unknown) => {
    const r = rel(p) ?? (typeof p === 'string' && path.resolve(p) === root ? '' : null)
    if (r === null) return
    const recursive = typeof opts === 'object' && opts !== null && (opts as { recursive?: boolean }).recursive
    ;(recursive ? st.rec.recursiveDirs : st.rec.dirs).add(r)
  }
  const wrap = <T extends object>(obj: T, name: string, note: (args: unknown[]) => void) => {
    const o = obj as Record<string, unknown>
    const orig = o[name]
    if (typeof orig !== 'function') return
    o[name] = function (this: unknown, ...args: unknown[]) {
      note(args)
      return (orig as (...a: unknown[]) => unknown).apply(this, args)
    }
  }
  for (const name of ['readFileSync', 'readFile', 'existsSync', 'statSync', 'lstatSync', 'stat', 'lstat', 'accessSync', 'access', 'createReadStream', 'openSync', 'open', 'copyFileSync', 'copyFile', 'cpSync', 'cp']) {
    wrap(fs, name, (a) => read(a[0]))
  }
  for (const name of ['readFile', 'stat', 'lstat', 'access', 'open', 'copyFile', 'cp']) wrap(fs.promises, name, (a) => read(a[0]))
  for (const name of ['readdirSync', 'readdir', 'opendirSync', 'opendir']) wrap(fs, name, (a) => list(a[0], a[1]))
  for (const name of ['readdir', 'opendir']) wrap(fs.promises, name, (a) => list(a[0], a[1]))
  for (const name of ['globSync', 'glob']) {
    wrap(fs, name, (a) => {
      const cwd = (a[1] as { cwd?: string } | undefined)?.cwd ?? process.cwd()
      const r = rel(cwd) ?? (path.resolve(cwd) === root ? '' : null)
      if (r !== null) st.rec.recursiveDirs.add(r)
    })
  }
  const spawned = (cmd: unknown, args: unknown, opts: unknown) => {
    const argv = Array.isArray(args) ? args : []
    const o = (Array.isArray(args) ? opts : args) as { cwd?: string | URL } | undefined
    const cwdRaw = o?.cwd ?? process.cwd()
    const cwd = path.resolve(cwdRaw instanceof URL ? fileURLToPath(cwdRaw) : cwdRaw)
    const inRepo = cwd === root || cwd.startsWith(`${root}/`)
    const first = typeof cmd === 'string' ? cmd.trim().split(/\s+/)[0] : ''
    if (inRepo && path.basename(first) === 'git') st.rec.spawnRepo = true
    const words = [...(typeof cmd === 'string' ? cmd.split(/\s+/) : []), ...argv.map(String)]
    for (const w of words) {
      const r = rel(path.resolve(cwd, w))
      if (r && /[./]/.test(w) && exists(path.join(root, r))) {
        st.rec.reads.add(r)
        st.rec.spawnTmp = true
      }
    }
  }
  for (const name of ['execFileSync', 'execFile', 'spawnSync', 'spawn', 'fork']) wrap(cp, name, (a) => spawned(a[0], a[1], a[2]))
  for (const name of ['execSync', 'exec']) wrap(cp, name, (a) => spawned(a[0], undefined, a[1]))
  syncBuiltinESMExports()
}

if (out) {
  if (!g.__eeTestDeps) {
    g.__eeTestDeps = { rec: fresh(), installed: false, appendFileSync: fs.appendFileSync }
  }
  const st = g.__eeTestDeps
  // Setup files run once per spec file: each file starts its own record.
  st.rec = fresh()
  if (!st.installed) {
    install()
    st.installed = true
  }
  afterAll(() => {
    const spec = rel(expect.getState().testPath)
    if (!spec) return
    const r = st.rec
    st.appendFileSync(
      path.join(out, `unit-${process.pid}.jsonl`),
      `${JSON.stringify({
        spec,
        reads: [...r.reads].filter((f) => f !== spec).sort(),
        dirs: [...r.dirs].sort(),
        recursiveDirs: [...r.recursiveDirs].sort(),
        spawnRepo: r.spawnRepo,
        spawnTmp: r.spawnTmp,
      })}\n`,
    )
  })
}
