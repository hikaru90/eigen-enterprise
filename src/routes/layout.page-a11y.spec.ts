import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditSource, type Finding } from '../lib/a11y/page-style-audit'
import { cssBlock, stripCssComments, themeContexts } from '../lib/a11y/theme-contexts'

/**
 * Accessibility on the individual pages (Contribute b73604ff, part 2). Part 1
 * (layout.contrast.spec.ts) holds the theme to WCAG 2.1 AA; this holds every
 * page and component to it: no text below the 13px floor, no token text faded
 * below 4.5:1, no removed focus outline without a replacement
 * (src/lib/a11y/page-style-audit.ts has the rules).
 *
 * Every source under src/ and modules/ is held to it, with no area exempt;
 * the only exceptions are the single ACCEPTED findings below, each with its
 * reason.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const css = stripCssComments(readFileSync(path.join(here, 'layout.css'), 'utf-8'))
const base = themeContexts(css)
/**
 * Light and dark (signed out), the light nucleus in both OS modes, and the
 * app frame: the sidebar and top bar re-scope the tokens to ink inside the
 * light page, so faded text there is measured on ink as well.
 */
const contexts = {
  ...base,
  'app frame': { ...base['nucleus, light'], ...cssBlock(css, '.ink-scope') },
}

/**
 * Single findings that are correct as written, each with the reason. A
 * dialog / popover content element is the focus scope bits-ui moves focus
 * into: focus lands on its first focusable child, and the container itself is
 * only a programmatic target (not in the tab order) when it has none.
 */
const ACCEPTED: { file: string; match: string; why: string }[] = [
  {
    file: 'src/lib/components/ui/alert-dialog/alert-dialog-content.svelte',
    match: 'outline-hidden',
    why: 'focus scope container; focus goes to its buttons',
  },
  {
    file: 'src/lib/components/ui/popover/popover-content.svelte',
    match: 'outline-hidden',
    why: 'focus scope container; focus goes to its first control',
  },
]

const ROOTS = ['src', 'modules']
const SKIP_DIRS = new Set(['node_modules', 'paraglide', 'test', 'vitest-stubs'])

function sources(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (!SKIP_DIRS.has(entry)) out.push(...sources(full))
    } else if (
      entry.endsWith('.svelte') ||
      (/\.ts$/.test(entry) && !/\.(spec|test)\.ts$/.test(entry))
    ) {
      out.push(full)
    }
  }
  return out
}

/** The auditor's own docs name the patterns it looks for. */
const AUDITOR = 'src/lib/a11y/page-style-audit.ts'
const files = ROOTS.flatMap((root) => sources(path.join(repo, root)))
  .map((full) => path.relative(repo, full).split(path.sep).join('/'))
  .filter((file) => file !== AUDITOR)
const findings = new Map<string, Finding[]>()
for (const file of files) {
  const source = readFileSync(path.join(repo, file), 'utf-8')
  let found: Finding[]
  try {
    found = auditSource(source, { contexts }, { markup: file.endsWith('.svelte') })
  } catch (error) {
    throw new Error(`${file}: ${(error as Error).message}`, { cause: error })
  }
  const kept = found.filter((f) => !ACCEPTED.some((a) => a.file === file && a.match === f.match))
  if (kept.length) findings.set(file, kept)
}

const describeFinding = (file: string, f: Finding) => `${file}:${f.line} ${f.kind} ${f.match}`

describe('page-level accessibility style guard', () => {
  it('finds sources to audit', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('no tiny text, faded text or removed focus outline anywhere', () => {
    const offenders = [...findings]
      .flatMap(([file, found]) => found.map((f) => describeFinding(file, f)))
    expect(offenders, offenders.join('\n')).toEqual([])
  })

  it('every accepted exception still exists (delete stale ones)', () => {
    for (const a of ACCEPTED) {
      const source = readFileSync(path.join(repo, a.file), 'utf-8')
      const hits = auditSource(source, { contexts }).filter((f) => f.match === a.match)
      expect(hits.length, `${a.file}: ${a.match} (${a.why})`).toBe(1)
    }
  })
})
