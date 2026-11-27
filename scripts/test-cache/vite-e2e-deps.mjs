// Test cache for browser e2e (scripts/test-cache/README.md): a Vite dev-server plugin, on only
// when the e2e harness records (EE_E2E_DEPS=1). It answers, between tests, which repo files
// the last test ran:
//   - on the server: V8 precise coverage of the dev server's own process (every module Vite
//     loads for SSR carries `//# sourceURL=<file>`), so a file counts when its code executed;
//   - in the browser: the source modules the page requested (each test gets a fresh browser
//     context, so it requests every module it uses).
// POST /__e2e-deps/take    → { files, inner } since the previous take (inner: their own code ran)
// GET  /__e2e-deps/graph   → { importers, inner, seen } for the whole run
import fs from 'node:fs'
import { Session } from 'node:inspector/promises'
import path from 'node:path'

const SKIP = /(^|\/)(node_modules|\.svelte-kit|\.git)(\/|$)/

/** @returns {import('vite').Plugin | null} */
export function e2eDeps() {
  if (process.env.EE_E2E_DEPS !== '1') return null
  const root = fs.realpathSync(process.cwd())
  /** client URLs requested since the last take */
  let requested = new Set()
  /** files with a non-module-level function that ran, and every file seen, over the whole run */
  const inner = new Set()
  const seen = new Set()
  /** @type {Session} */
  let session
  /** @type {import('vite').ViteDevServer} */
  let server

  /** @param {string} abs */
  const relFile = (abs) => {
    const clean = abs.split('?')[0].replace(/^file:\/\//, '')
    if (!clean.startsWith(`${root}/`)) return null
    const r = clean.slice(root.length + 1)
    return SKIP.test(r) ? null : r
  }
  /** @param {string} url */
  const fromUrl = (url) => {
    const u = decodeURIComponent(url.split('?')[0])
    if (u.startsWith('/@fs/')) return relFile(u.slice(4))
    if (u.startsWith('/@') || u.startsWith('/__')) return null
    const r = relFile(path.join(root, u))
    return r && fs.existsSync(path.join(root, r)) && fs.statSync(path.join(root, r)).isFile() ? r : null
  }

  /** scriptId → source, fetched once per script that ran more than its module body */
  const sources = new Map()
  /**
   * Did the module's own code run, beyond loading? Not counted: the module body and Vite's
   * wrapper around it (they contain every other function), and the export getters Vite's SSR
   * transform writes (`() => { try { return x } catch {} }`): those run whenever an importer
   * reads the binding, which makes the file count for that test, but they are not its code.
   * @param {{ scriptId: string, functions: { ranges: { startOffset: number, endOffset: number, count: number }[] }[] }} sc
   * @param {{ ranges: { startOffset: number, endOffset: number, count: number }[] }[]} ran
   */
  async function ranOwnCode(sc, ran) {
    const all = sc.functions.map((f) => f.ranges[0])
    const outer = (r) => all.every((o) => r.startOffset <= o.startOffset && r.endOffset >= o.endOffset)
    const candidates = ran.map((f) => f.ranges[0]).filter((r) => !outer(r))
    if (candidates.length === 0) return false
    if (!sources.has(sc.scriptId)) {
      const { scriptSource } = await session.post('Debugger.getScriptSource', { scriptId: sc.scriptId })
      sources.set(sc.scriptId, scriptSource)
    }
    const src = sources.get(sc.scriptId)
    return candidates.some((r) => !src.startsWith('() => { try { return ', r.startOffset))
  }

  async function take() {
    const files = new Set()
    const ranInner = new Set()
    const { result } = await session.post('Profiler.takePreciseCoverage')
    for (const sc of result) {
      const file = sc.url && !sc.url.startsWith('node:') ? relFile(sc.url) : null
      if (!file) continue
      const ran = sc.functions.filter((f) => f.ranges[0].count > 0)
      if (ran.length === 0) continue
      files.add(file)
      seen.add(file)
      if (await ranOwnCode(sc, ran)) {
        inner.add(file)
        ranInner.add(file)
      }
    }
    for (const url of requested) {
      const r = fromUrl(url)
      if (r) {
        files.add(r)
        seen.add(r)
      }
    }
    requested = new Set()
    return { files: [...files].sort(), inner: [...ranInner].sort() }
  }

  function graph() {
    /** @type {Record<string, Set<string>>} */
    const importers = {}
    for (const env of Object.values(server.environments)) {
      for (const mod of env.moduleGraph.idToModuleMap.values()) {
        const file = mod.file && relFile(mod.file)
        if (!file) continue
        for (const imp of mod.importers) {
          const by = imp.file && relFile(imp.file)
          if (by && by !== file) (importers[file] ??= new Set()).add(by)
        }
      }
    }
    return {
      importers: Object.fromEntries(Object.entries(importers).map(([k, v]) => [k, [...v].sort()])),
      inner: [...inner].sort(),
      seen: [...seen].sort(),
    }
  }

  return {
    name: 'ee-e2e-deps',
    apply: 'serve',
    async configureServer(s) {
      server = s
      session = new Session()
      session.connect()
      // The debugger domain only serves script sources (export getters are told apart by text).
      await session.post('Debugger.enable')
      await session.post('Profiler.enable')
      await session.post('Profiler.startPreciseCoverage', { callCount: true, detailed: false })
      s.middlewares.use((req, res, next) => {
        const url = req.url ?? ''
        if (url === '/__e2e-deps/take' && req.method === 'POST') {
          take().then(
            (taken) => {
              res.setHeader('content-type', 'application/json')
              res.end(JSON.stringify(taken))
            },
            (err) => {
              res.statusCode = 500
              res.end(String(err))
            },
          )
          return
        }
        if (url === '/__e2e-deps/graph') {
          res.setHeader('content-type', 'application/json')
          res.end(JSON.stringify(graph()))
          return
        }
        requested.add(url)
        next()
      })
    },
  }
}
