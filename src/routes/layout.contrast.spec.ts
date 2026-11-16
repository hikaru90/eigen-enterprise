import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  AA_TEXT,
  AA_UI,
  THEME_CONTRAST_PAIRS,
  auditContrast,
  composite,
  contrastRatio,
  parseColor,
  type ContrastPair,
  type Rgba,
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

/**
 * Where the tokens are composed (no active brand set); see themeContexts.
 * Plus the app frame: the shell's sidebar and top bar re-scope the tokens to
 * ink (.ink-scope) inside the light nucleus wrapper.
 */
const BASE_CONTEXTS = themeContexts(css)
const CONTEXTS = {
  ...BASE_CONTEXTS,
  'app frame': { ...BASE_CONTEXTS['nucleus, light'], ...block('.ink-scope') },
}

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

/**
 * The website's accents and gradients (2026-11-16): part marks, the ice and
 * glow stages, the night frame. Their colours are custom properties on their
 * classes (`--mark-bg`/`--mark-fg`, `--stage-bg`/`--stage-fg`/`--on-soft`), so
 * they are measured here like the tokens: against EVERY stop of a gradient.
 */
describe('website accents meet WCAG 2.1 AA', () => {
  const root = block(':root')
  const resolveVars = (value: string): string => {
    let out = value
    for (let i = 0; i < 4 && out.includes('var('); i++) {
      out = out.replace(/var\((--[\w-]+)\)/g, (_, name: string) => {
        const v = root[name]
        if (v === undefined) throw new Error(`layout.css :root does not declare ${name}`)
        return v
      })
    }
    return out
  }
  /** The opaque colours a foreground can land on: each stop, translucent stops over the opaque base. */
  const surfaces = (value: string): Rgba[] => {
    const literals = resolveVars(value).match(/#[0-9a-f]{3,8}\b|rgba?\([^)]*\)/gi)
    if (!literals) throw new Error(`no colour stops in "${value}"`)
    const colours = literals.map((c) => parseColor(c, value))
    const base = colours.findLast((c) => c.alpha === 1)
    if (!base) throw new Error(`"${value}" has no opaque stop to paint on`)
    return colours.map((c) => (c.alpha === 1 ? c : composite(c, base)))
  }
  const colour = (value: string): Rgba => parseColor(resolveVars(value), value)
  const worst = (fg: string, on: string): number =>
    Math.min(...surfaces(on).map((s) => contrastRatio(colour(fg), s)))

  for (const name of ['blue', 'ice', 'green', 'violet', 'peach', 'yellow', 'grey', 'ink', 'white']) {
    it(`.mark-${name}: the glyph on every stop of its square ≥ ${AA_UI}:1`, () => {
      const mark = block(`.mark-${name}`)
      expect(worst(mark['--mark-fg'], mark['--mark-bg'])).toBeGreaterThanOrEqual(AA_UI)
    })
  }

  it(`.stage-ice: text and secondary text ≥ ${AA_TEXT}:1`, () => {
    const stage = block('.stage-ice')
    expect(worst(stage['--stage-fg'], stage['--stage-bg'])).toBeGreaterThanOrEqual(AA_TEXT)
    expect(worst(stage['--on-soft'], stage['--stage-bg'])).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it(`.stage-glow: text and secondary text on its dark ground ≥ ${AA_TEXT}:1 (the glow rises behind the widget)`, () => {
    const stage = block('.stage-glow')
    expect(worst(stage['--stage-fg'], stage['--stage-bg'])).toBeGreaterThanOrEqual(AA_TEXT)
    expect(worst(stage['--on-soft'], stage['--stage-bg'])).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it(`the night frame: frame text on every glow ≥ ${AA_TEXT}:1`, () => {
    const frame = CONTEXTS['app frame']
    for (const token of ['--foreground', '--muted-foreground'] as const) {
      expect(worst(frame[token], root['--gradient-night'])).toBeGreaterThanOrEqual(AA_TEXT)
    }
  })
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
