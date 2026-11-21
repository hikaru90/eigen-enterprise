import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * SvelteKit refuses a route module that exports anything but its own names
 * (or `_`-prefixed ones): the page answers 500 "Invalid export" — but only
 * when the dev server or the build loads it, never in a unit test that
 * imports the file. This catches it at unit time (a 2 MB-cap constant
 * exported from drive/file/[id]/+page.server.ts broke every Drive file page).
 */
const ROUTES = path.dirname(fileURLToPath(import.meta.url))

const PAGE_OPTIONS = ['prerender', 'ssr', 'csr', 'trailingSlash', 'config', 'entries']
const ALLOWED: Record<string, string[]> = {
  '+page.server.ts': ['load', 'actions', ...PAGE_OPTIONS],
  '+page.ts': ['load', ...PAGE_OPTIONS],
  '+layout.server.ts': ['load', ...PAGE_OPTIONS],
  '+layout.ts': ['load', ...PAGE_OPTIONS],
  '+server.ts': ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD', 'fallback', ...PAGE_OPTIONS],
}

function routeFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) out.push(...routeFiles(full))
    else if (name in ALLOWED) out.push(full)
  }
  return out
}

/** Value exports by name (`export const|let|function|async function|class X`, `export { a, b as c }`); type exports don't count. */
function exportedNames(source: string): string[] {
  const names: string[] = []
  for (const m of source.matchAll(/^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm)) names.push(m[1]!)
  for (const m of source.matchAll(/^export\s*\{([^}]*)\}/gm)) {
    for (const part of m[1]!.split(',')) {
      const spec = part.trim()
      if (!spec || spec.startsWith('type ')) continue
      names.push(spec.split(/\s+as\s+/).at(-1)!.trim())
    }
  }
  return names
}

describe('route modules export only what SvelteKit allows', () => {
  it('finds the route modules', () => {
    expect(routeFiles(ROUTES).length).toBeGreaterThan(50)
  })

  it('every +page/+layout/+server module exports only its own names or _-prefixed ones', () => {
    const bad: string[] = []
    for (const file of routeFiles(ROUTES)) {
      const allowed = ALLOWED[path.basename(file)]!
      for (const name of exportedNames(readFileSync(file, 'utf8'))) {
        if (!allowed.includes(name) && !name.startsWith('_')) bad.push(`${path.relative(ROUTES, file)}: ${name}`)
      }
    }
    expect(bad).toEqual([])
  })

  it('the parser sees a stray export (guards the guard)', () => {
    expect(exportedNames('export const load = 1\nexport const TEXT_MAX = 2\nexport type X = 1\nexport { a as actions, b }')).toEqual(['load', 'TEXT_MAX', 'actions', 'b'])
  })
})
