import { describe, expect, it } from 'vitest'
import { brandCorpus } from '../corpus/runtime'
import { loadPickerIndex, toVisualSetVars } from '../taxonomy/load-index'
import {
  AA_TEXT,
  AA_UI,
  THEME_CONTRAST_PAIRS,
  auditContrast,
  composite,
  contrastRatio,
  enforceContrast,
  pairContrast,
  parseColor,
  type ContrastPair,
} from './contrast'

const ratio = (a: string, b: string) => contrastRatio(parseColor(a, 'a'), parseColor(b, 'b'))

describe('WCAG 2.1 contrast math', () => {
  it('matches the reference ratios', () => {
    expect(ratio('#000000', '#ffffff')).toBeCloseTo(21, 5)
    expect(ratio('#ffffff', '#ffffff')).toBeCloseTo(1, 5)
    // The canonical AA edge cases: #767676 passes on white, #777777 does not.
    expect(ratio('#767676', '#ffffff')).toBeCloseTo(4.54, 2)
    expect(ratio('#777777', '#ffffff')).toBeLessThan(AA_TEXT)
    expect(ratio('#999999', '#ffffff')).toBeCloseTo(2.85, 2)
  })

  it('reads every color syntax the themes use', () => {
    for (const value of [
      '#111',
      '#111111',
      'rgb(17 17 17)',
      'hsl(0 0% 6.7%)',
      'oklch(0.1776 0 0)',
    ]) {
      expect(ratio(value, '#ffffff')).toBeGreaterThan(18)
    }
  })

  it('fails loud on a value it cannot read', () => {
    expect(() => parseColor('var(--x)', '--x')).toThrow(/unparseable color for --x/)
  })

  it('composites translucent paint over its surface before measuring', () => {
    const half = composite(parseColor('rgb(0 0 0 / 50%)', 'x'), parseColor('#ffffff', 'y'))
    expect(half.r).toBeCloseTo(0.5, 5)
    expect(half.alpha).toBe(1)
    const pair: ContrastPair = {
      id: 'fg/50 on bg',
      fg: { token: '--fg', alpha: 0.5 },
      on: [{ token: '--bg' }],
      min: AA_TEXT,
      use: 'test',
    }
    // #000 at 50% over white paints #808080: 3.95:1, not black's 21:1.
    expect(pairContrast({ '--fg': '#000000', '--bg': '#ffffff' }, pair)).toBeCloseTo(3.95, 1)
  })

  it('refuses a translucent bottom layer (there is nothing to paint it on)', () => {
    const pair: ContrastPair = {
      id: 'x',
      fg: { token: '--fg' },
      on: [{ token: '--bg' }],
      min: AA_TEXT,
      use: 'test',
    }
    expect(() => pairContrast({ '--fg': '#000', '--bg': 'rgb(255 255 255 / 50%)' }, pair)).toThrow(
      /must be opaque/,
    )
  })
})

describe('THEME_CONTRAST_PAIRS', () => {
  it('holds text to 4.5:1 and the input boundary / focus ring to 3:1', () => {
    for (const pair of THEME_CONTRAST_PAIRS) {
      const ui = pair.fg.token === '--input' || pair.fg.token === '--ring'
      expect(pair.min, pair.id).toBe(ui ? AA_UI : AA_TEXT)
    }
    const ids = THEME_CONTRAST_PAIRS.map((p) => p.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of [
      'foreground on background',
      'muted-foreground on muted',
      'muted-foreground on card',
      'primary-foreground on primary',
      'destructive on background + destructive/10',
      'input on background',
      'ring on card',
    ]) {
      expect(ids).toContain(id)
    }
  })
})

const LOW_CONTRAST_SET = {
  '--background': '#ffffff',
  '--foreground': '#111111',
  '--card': '#ffffff',
  '--card-foreground': '#111111',
  '--popover': '#ffffff',
  '--popover-foreground': '#111111',
  '--primary': '#fde047',
  '--primary-foreground': '#ffffff',
  '--secondary': '#f4f4f5',
  '--secondary-foreground': '#111111',
  '--muted': '#f4f4f5',
  '--muted-foreground': '#a1a1aa',
  '--accent': '#f4f4f5',
  '--accent-foreground': '#111111',
  '--destructive': '#f87171',
  '--border': 'rgb(0 0 0 / 8%)',
  '--input': 'rgb(0 0 0 / 10%)',
  '--ring': '#d4d4d8',
}

describe('enforceContrast (brand sets theme the app at AA)', () => {
  it('moves only the failing foregrounds / indicators until every pair passes', () => {
    expect(auditContrast(LOW_CONTRAST_SET).some((r) => !r.pass)).toBe(true)
    const fixed = enforceContrast(LOW_CONTRAST_SET)
    for (const result of auditContrast(fixed)) {
      expect(result.ratio, result.pair.id).toBeGreaterThanOrEqual(result.pair.min)
    }
    // Surfaces are the brand: never moved.
    for (const surface of [
      '--background',
      '--card',
      '--popover',
      '--muted',
      '--secondary',
      '--accent',
      '--primary',
    ]) {
      expect(fixed[surface], surface).toBe(
        LOW_CONTRAST_SET[surface as keyof typeof LOW_CONTRAST_SET],
      )
    }
    // Passing tokens stay byte-identical.
    expect(fixed['--foreground']).toBe('#111111')
    expect(fixed['--secondary-foreground']).toBe('#111111')
    // White on a pale yellow cannot pass: it flips to a dark text colour.
    expect(ratio(fixed['--primary-foreground'], '#fde047')).toBeGreaterThanOrEqual(AA_TEXT)
  })

  it('moves a translucent indicator by opacity first, keeping its colour', () => {
    const fixed = enforceContrast(LOW_CONTRAST_SET)
    expect(fixed['--input']).toMatch(/^oklch\(0 0 \S+ \/ 0\.\d+\)$/)
  })

  it('stays as close as it can: it stops at the first value that passes', () => {
    const fixed = enforceContrast(LOW_CONTRAST_SET)
    const muted = auditContrast(fixed).filter((r) => r.pair.fg.token === '--muted-foreground')
    expect(Math.min(...muted.map((r) => r.ratio))).toBeLessThan(AA_TEXT + 0.15)
  })

  it('is deterministic', () => {
    expect(enforceContrast(LOW_CONTRAST_SET)).toEqual(enforceContrast({ ...LOW_CONTRAST_SET }))
  })

  it('leaves pairs the record does not fully declare alone', () => {
    const partial = { '--background': '#ffffff', '--muted': '#f4f4f5' }
    expect(enforceContrast(partial)).toEqual(partial)
  })

  it('moves a surface that sits on the wrong side of the text (dark --muted in a light theme)', () => {
    const daisyLike = {
      ...LOW_CONTRAST_SET,
      '--muted': 'oklch(0% 0 0)',
      '--muted-foreground': 'oklch(0.35 0 0)',
    }
    const fixed = enforceContrast(daisyLike)
    for (const result of auditContrast(fixed)) {
      expect(result.ratio, result.pair.id).toBeGreaterThanOrEqual(result.pair.min)
    }
    expect(fixed['--muted']).not.toBe(daisyLike['--muted'])
    // The theme's own muted text colour already worked on the page: it stays.
    expect(fixed['--muted-foreground']).toBe('oklch(0.35 0 0)')
    expect(fixed['--background']).toBe('#ffffff')
  })

  it('fails loud when the surfaces leave no room', () => {
    // One foreground on a white and a black surface at once: nothing reaches 7:1 on both.
    const impossible: ContrastPair[] = [
      { id: 'fg on white', fg: { token: '--fg' }, on: [{ token: '--a' }], min: 7, use: 't' },
      { id: 'fg on black', fg: { token: '--fg' }, on: [{ token: '--b' }], min: 7, use: 't' },
    ]
    expect(() =>
      enforceContrast({ '--fg': '#777777', '--a': '#ffffff', '--b': '#000000' }, impossible),
    ).toThrow(/cannot reach 7:1/)
  })

  it('brings every shipped brand style (corpus + picker) to AA in light and dark', () => {
    const sets: {
      name: string
      light: Record<string, string>
      dark: Record<string, string> | null
    }[] = [
      ...brandCorpus.items.map((item) => ({
        name: `corpus ${item.name}`,
        light: item.cssVars,
        dark: item.darkCssVars ?? null,
      })),
      ...loadPickerIndex('built')
        .nodes.filter((node) => node.level === 'variant')
        .map((node) => ({
          name: `picker ${node.id}`,
          light: toVisualSetVars(node.tokens.light),
          dark: toVisualSetVars(node.tokens.dark),
        })),
    ]
    expect(sets.length).toBeGreaterThan(50)
    for (const set of sets) {
      const light = enforceContrast(set.light)
      const dark = enforceContrast({ ...light, ...(set.dark ?? {}) })
      for (const [mode, tokens] of [
        ['light', light],
        ['dark', dark],
      ] as const) {
        for (const result of auditContrast(tokens)) {
          expect(result.ratio, `${set.name} ${mode}: ${result.pair.id}`).toBeGreaterThanOrEqual(
            result.pair.min,
          )
        }
      }
    }
  })
})
