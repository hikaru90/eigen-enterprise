// The dev server's pre-bundle list for the office viewers, derived from their
// imports (vite.config.ts optimizeDeps.include). The viewers load lazily from
// the Drive file page, so whatever only they import is discovered at click
// time; each late find re-runs dep optimization and reloads the page
// mid-interaction, wiping editor state (the e2e journeys caught it twice
// with a hand-kept list). Scanning the code keeps the list complete.
// Dev-only: the build is unaffected.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const IMPORT_RE = /(?:^|[\s;>])(?:import|export)\s+(type\s+)?(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

/**
 * Bare package specifiers a source file imports at runtime (type-only imports skipped).
 * @param {string} source
 * @returns {Set<string>}
 */
export function bareImports(source) {
  const out = new Set()
  for (const m of source.matchAll(IMPORT_RE)) {
    const typeOnly = Boolean(m[1])
    const spec = m[2] ?? m[3]
    if (!spec || typeOnly) continue
    if (spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('$') || spec.startsWith('node:')) continue
    if (spec.includes('?')) continue // asset imports (?url, ?raw) are not pre-bundled deps
    out.add(spec)
  }
  return out
}

/**
 * Every bare import under `dir` in shipped office code (no specs, no test utils), sorted.
 * @param {string} dir
 * @returns {string[]}
 */
export function officePrebundle(dir) {
  /** @type {Set<string>} */
  const deps = new Set()
  /** @param {string} d */
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'test-utils') walk(p)
        continue
      }
      if (!/\.(ts|svelte)$/.test(entry.name) || /\.(spec|test)\.ts$/.test(entry.name) || entry.name.endsWith('.d.ts')) continue
      // <format>/text.ts: the server-side agent text (plan/phase-office-files.md §3), never in the browser.
      if (entry.name === 'text.ts') continue
      for (const dep of bareImports(readFileSync(p, 'utf8'))) {
        // Svelte is the Svelte plugin's to handle, never pre-bundled.
        if (dep === 'svelte' || dep.startsWith('svelte/')) continue
        deps.add(dep)
      }
    }
  }
  walk(dir)
  return [...deps].sort()
}
