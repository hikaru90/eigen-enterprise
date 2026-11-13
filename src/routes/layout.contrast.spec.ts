import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AA_TEXT,
  AA_UI,
  THEME_CONTRAST_PAIRS,
  auditContrast,
  type ContrastPair,
} from '../../modules/brand/style-format/contrast'
import { cssBlock, stripCssComments, themeContexts } from '../lib/a11y/theme-contexts'

/**
 * Accessibility of the app's own theme (Contribute b73604ff, round 3 W6):
 * every token pair the UI paints together meets WCAG 2.1 AA in every context
 * the tokens are composed in, and the global type / focus / motion rules hold.
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const css = stripCssComments(readFileSync(path.join(here, 'layout.css'), 'utf-8'))
const block = (selector: string) => cssBlock(css, selector)

/** Where the tokens are composed (no active brand set); see themeContexts. */
const CONTEXTS = themeContexts(css)

/** App-shell surfaces beyond the semantic roles (src/lib/components/app-shell.svelte). */
const SHELL_PAIRS: ContrastPair[] = [
  {
    id: 'foreground on sidebar',
    fg: { token: '--foreground' },
    on: [{ token: '--sidebar' }],
    min: AA_TEXT,
    use: 'nav',
  },
  {
    id: 'muted-foreground on sidebar',
    fg: { token: '--muted-foreground' },
    on: [{ token: '--sidebar' }],
    min: AA_TEXT,
    use: 'nav',
  },
  {
    id: 'ring on sidebar',
    fg: { token: '--ring' },
    on: [{ token: '--sidebar' }],
    min: AA_UI,
    use: 'nav focus',
  },
  {
    id: 'primary on background',
    fg: { token: '--primary' },
    on: [{ token: '--background' }],
    min: AA_TEXT,
    use: 'text-primary links',
  },
  {
    id: 'primary on card',
    fg: { token: '--primary' },
    on: [{ token: '--card' }],
    min: AA_TEXT,
    use: 'text-primary links',
  },
  // The status pill's "on" dot (src/lib/components/page/status-pill.svelte).
  // Held to the text minimum, not just 3:1, so the token can colour success text too.
  {
    id: 'success on background',
    fg: { token: '--success' },
    on: [{ token: '--background' }],
    min: AA_TEXT,
    use: 'status pill "on" dot, success text',
  },
  {
    id: 'success on card',
    fg: { token: '--success' },
    on: [{ token: '--card' }],
    min: AA_TEXT,
    use: 'status pill "on" dot, success text',
  },
]

describe('app theme tokens meet WCAG 2.1 AA', () => {
  for (const [context, tokens] of Object.entries(CONTEXTS)) {
    describe(context, () => {
      for (const result of auditContrast(tokens, [...THEME_CONTRAST_PAIRS, ...SHELL_PAIRS])) {
        it(`${result.pair.id} ≥ ${result.pair.min}:1 (${result.pair.use})`, () => {
          expect(
            result.ratio,
            `${context}: ${result.pair.id} = ${result.ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(result.pair.min)
        })
      }
    })
  }
})

function rem(value: string): number {
  const m = value.trim().match(/^([\d.]+)rem$/)
  if (!m) throw new Error(`expected a rem length, got "${value}"`)
  return Number(m[1])
}

describe('global type, focus and motion', () => {
  const theme = block('@theme')

  it('the smallest text step is 13px, with a comfortable line height', () => {
    expect(rem(theme['--text-xs']) * 16).toBeGreaterThanOrEqual(13)
    const lh = theme['--text-xs--line-height'].match(/^calc\(([\d.]+) \/ ([\d.]+)\)$/)
    expect(lh, theme['--text-xs--line-height']).not.toBeNull()
    expect(Number(lh![1]) / Number(lh![2])).toBeGreaterThanOrEqual(1.35)
  })

  it('never shrinks the root or body font size below the 16px default', () => {
    for (const m of css.matchAll(/(?:^|[\s,}])(html|body|:root)\s*\{([^}]*)\}/g)) {
      expect(m[2], `${m[1]} sets a font-size`).not.toMatch(/font-size\s*:/)
    }
  })

  it('every focusable element gets a solid, visible focus outline in the ring colour', () => {
    expect(css).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/)
    expect(css).not.toContain('outline-ring/50')
  })

  it('honours prefers-reduced-motion globally', () => {
    const m = css.match(/@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n {2}\}/)
    expect(m, 'reduced-motion block').not.toBeNull()
    expect(m![1]).toMatch(/animation-duration:\s*0\.01ms !important/)
    expect(m![1]).toMatch(/transition-duration:\s*0\.01ms !important/)
    expect(m![1]).toMatch(/scroll-behavior:\s*auto !important/)
  })

  it('citation chips stay at the 13px floor', () => {
    for (const m of css.matchAll(/\.chat-citation(?:--block)?\s*\{([^}]*)\}/g)) {
      const size = m[1].match(/font-size:\s*([^;]+);/)
      if (size) expect(rem(size[1]) * 16).toBeGreaterThanOrEqual(13)
    }
  })
})
