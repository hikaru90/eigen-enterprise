import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { auditSource, type Finding } from '../lib/a11y/page-style-audit'
import { stripCssComments, themeContexts } from '../lib/a11y/theme-contexts'

/**
 * Accessibility on the individual pages (Contribute b73604ff, part 2). Part 1
 * (layout.contrast.spec.ts) holds the theme to WCAG 2.1 AA; this holds every
 * page and component to it: no text below the 13px floor, no token text faded
 * below 4.5:1, no removed focus outline without a replacement
 * (src/lib/a11y/page-style-audit.ts has the rules).
 *
 * REMAINING lists the areas not fixed yet, by name, so they are a visible
 * to-do and not a silent skip. Each must still contain findings: once an area
 * is clean, delete its entry and the guard holds it from then on.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const repo = path.resolve(here, '../..')
const contexts = themeContexts(
  stripCssComments(readFileSync(path.join(here, 'layout.css'), 'utf-8')),
)

type Area = { area: string; why: string; paths: string[] }

const REMAINING: Area[] = [
  {
    area: 'Email',
    why: 'inbox / templates / people under rework in a parallel stream (Contribute eb674853)',
    paths: ['src/routes/(nucleus)/m/email/', 'modules/email/', 'src/lib/components/email/'],
  },
  {
    area: 'Contacts',
    why: 'contacts module under rework in a parallel stream',
    paths: ['src/routes/(nucleus)/m/contacts/', 'modules/contacts/'],
  },
  {
    area: 'Memory',
    why: 'memory pages and capture components under rework in a parallel stream',
    paths: [
      'src/routes/(nucleus)/m/memory/',
      'src/lib/memory/',
      'src/lib/components/memory-',
      'src/lib/components/capture-',
      'src/lib/components/first-capture-nudge.svelte',
      'src/lib/components/grounding-question-card.svelte',
    ],
  },
  {
    area: 'Brand',
    why: 'brand pages and picker under rework in a parallel stream (Contribute 288dc1d2)',
    paths: ['src/routes/(nucleus)/brand/', 'src/lib/components/brand-picker/', 'modules/brand/'],
  },
  {
    area: 'Sidebar and presence',
    why: 'main sidebar / nav footer and presence under rework in a parallel stream',
    paths: ['src/lib/components/app-shell.svelte', 'src/lib/messages/presence-'],
  },
  {
    area: 'Settings › Modules',
    why: 'module settings pages under rework in a parallel stream',
    paths: ['src/routes/(nucleus)/settings/modules/'],
  },
]

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

const areaOf = (file: string) => REMAINING.find((a) => a.paths.some((p) => file.startsWith(p)))
const describeFinding = (file: string, f: Finding) => `${file}:${f.line} ${f.kind} ${f.match}`

describe('page-level accessibility style guard', () => {
  it('finds sources to audit', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('no tiny text, faded text or removed focus outline outside the remaining areas', () => {
    const offenders = [...findings]
      .filter(([file]) => !areaOf(file))
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

  describe('remaining areas (fix, then delete the entry)', () => {
    for (const area of REMAINING) {
      it(`${area.area} — ${area.why}`, () => {
        for (const p of area.paths) {
          const exists =
            p.endsWith('/') || p.endsWith('.svelte')
              ? existsSync(path.join(repo, p))
              : files.some((f) => f.startsWith(p))
          expect(exists, `${area.area}: path "${p}" no longer exists`).toBe(true)
        }
        const count = [...findings]
          .filter(([file]) => areaOf(file) === area)
          .reduce((n, [, f]) => n + f.length, 0)
        expect(count, `${area.area} is clean: remove it from REMAINING`).toBeGreaterThan(0)
      })
    }
  })
})
