import type { BrandCorpusItem } from '../style-format/corpus'
import { describe, expect, it } from 'vitest'
import { brandSeedsSchema } from '../style-format/seeds'
import { oklabDistance, styleDistance, styleVector } from '../style-format/vector'
import { buildStyleVectorIndex, centroidMatch, centroidVector, MIN_SELECTION_PICKS } from './match'

function seeds(overrides: Partial<Record<string, unknown>> = {}) {
  return brandSeedsSchema.parse({
    seedColor: { l: 0.75, c: 0.06, h: 300 },
    neutralTintHue: 300,
    accentHueShift: null,
    chromaCurve: 'muted',
    darkModeStrategy: 'invert-tone',
    fonts: { fontPrimary: 'Inter', fontSecondary: 'Lora', fontMono: 'Geist Mono' },
    fluidScale: {
      baseSize: { min: 16, max: 18 },
      scaleRatio: { min: 1.125, max: 1.2 },
      viewport: { min: 400, max: 1200 },
      scaleSteps: 4,
      trackingCurve: 'neutral',
    },
    spaceRhythm: [0.25, 0.5, 1, 2],
    shapeCharacter: 'soft',
    radiusBase: '0.75rem',
    elevation: 'flat',
    motionPersonality: 'productive',
    grain: 0,
    ...overrides,
  })
}

function pastel(id: string, name: string, hue: number): BrandCorpusItem {
  return {
    id,
    name,
    seeds: seeds({ seedColor: { l: 0.75, c: 0.06, h: hue } }),
    cssVars: {
      '--background': 'oklch(0.985 0.005 300)',
      '--foreground': 'oklch(0.247 0.005 300)',
      '--primary': `oklch(0.75 0.06 ${hue})`,
      '--secondary': `oklch(0.9 0.03 ${hue})`,
      '--accent': `oklch(0.9 0.03 ${hue})`,
      '--muted': 'oklch(0.931 0.005 300)',
      '--border': 'oklch(0.697 0.005 300)',
      '--ring': `oklch(0.75 0.05 ${hue})`,
      '--card': 'oklch(0.985 0.005 300)',
      '--destructive': 'oklch(0.536 0.2 27)',
      '--radius': '0.75rem',
      '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
      '--font-sans': '"Inter"',
      '--font-display': '"Lora"',
      '--font-mono': '"Geist Mono"',
    },
    darkCssVars: { '--background': 'oklch(0.13 0.005 300)' },
    provenance: { source: 'archetype' },
    createdAt: '2026-09-09T00:00:00.000Z',
  }
}

const PASTEL_A = pastel('0a000000-0000-4000-8000-00000000000a', 'pastel-a', 290)
const PASTEL_B = pastel('0b000000-0000-4000-8000-00000000000b', 'pastel-b', 300)
const PASTEL_C = pastel('0c000000-0000-4000-8000-00000000000c', 'pastel-c', 310)
const PASTEL_D = pastel('0d000000-0000-4000-8000-00000000000d', 'pastel-d', 320)

// A neutral, sans-serif middle ground: distinct from the pastels but far
// from the terminal — it keeps the default top-3 test honest (6 items,
// 3 picked leaves 3 candidates).
const NEUTRAL_CANVAS: BrandCorpusItem = pastel(
  '0f000000-0000-4000-8000-00000000000f',
  'neutral-canvas',
  60,
)

const MONO_TERMINAL: BrandCorpusItem = {
  id: '0e000000-0000-4000-8000-00000000000e',
  name: 'mono-terminal',
  seeds: seeds({
    seedColor: { l: 0.7, c: 0.02, h: 145 },
    neutralTintHue: 145,
    fonts: { fontPrimary: 'JetBrains Mono', fontSecondary: 'JetBrains Mono', fontMono: 'JetBrains Mono' },
    radiusBase: '0px',
    shapeCharacter: 'sharp',
  }),
  cssVars: {
    '--background': 'oklch(0.985 0.005 145)',
    '--foreground': 'oklch(0.247 0.005 145)',
    '--primary': 'oklch(0.536 0.02 145)',
    '--secondary': 'oklch(0.853 0.01 145)',
    '--accent': 'oklch(0.853 0.01 145)',
    '--muted': 'oklch(0.931 0.005 145)',
    '--border': 'oklch(0.697 0.005 145)',
    '--ring': 'oklch(0.615 0.02 145)',
    '--card': 'oklch(0.985 0.005 145)',
    '--destructive': 'oklch(0.536 0.2 27)',
    '--radius': '0px',
    '--space-1': 'clamp(0.25rem, 0.2rem + 0.025vw, 0.3rem)',
    '--font-sans': '"JetBrains Mono"',
    '--font-display': '"JetBrains Mono"',
    '--font-mono': '"JetBrains Mono"',
  },
  darkCssVars: { '--background': 'oklch(0.13 0.005 145)' },
  provenance: { source: 'archetype' },
  createdAt: '2026-09-09T00:00:00.000Z',
}

const TOY_CORPUS = [PASTEL_A, PASTEL_B, PASTEL_C, PASTEL_D, NEUTRAL_CANVAS, MONO_TERMINAL]
const TOY_INDEX = buildStyleVectorIndex(TOY_CORPUS)
const PASTEL_PICKS = [PASTEL_A.id, PASTEL_B.id, PASTEL_C.id]

describe('buildStyleVectorIndex', () => {
  it('maps every corpus item id to its style vector', () => {
    expect(TOY_INDEX.size).toBe(TOY_CORPUS.length)
    expect(TOY_INDEX.get(PASTEL_A.id)).toEqual(styleVector(PASTEL_A))
  })
})

describe('centroidVector', () => {
  it('is the (float-exact) zero-distance mean of identical vectors', () => {
    const v = styleVector(PASTEL_A)
    const centroid = centroidVector([v, v, v])
    // OKLCH -> OKLab -> mean -> OKLCH round-trips carry ~1e-16 float noise.
    expect(styleDistance(centroid, v)).toBeCloseTo(0, 12)
  })

  it('lands between its inputs: centroid of two pastels is closer to each than they are to a terminal', () => {
    const a = styleVector(PASTEL_A)
    const b = styleVector(PASTEL_B)
    const mono = styleVector(MONO_TERMINAL)
    const centroid = centroidVector([a, b])
    expect(styleDistance(centroid, a)).toBeLessThan(styleDistance(a, mono))
    expect(styleDistance(centroid, b)).toBeLessThan(styleDistance(b, mono))
  })

  it('keeps hue through OKLab averaging (not naive channel means)', () => {
    const centroid = centroidVector([styleVector(PASTEL_A), styleVector(PASTEL_C)])
    const midHue = centroid.colors.primary
    const towardsB = oklabDistance(midHue, styleVector(PASTEL_B).colors.primary)
    const towardsA = oklabDistance(midHue, styleVector(PASTEL_A).colors.primary)
    const towardsD = oklabDistance(midHue, styleVector(PASTEL_D).colors.primary)
    // The mean of hues 290 and 310 must sit nearest hue 300.
    expect(towardsB).toBeLessThan(Math.min(towardsA, towardsD))
  })

  it('throws loud on an empty pick set', () => {
    expect(() => centroidVector([])).toThrow(/no vectors/)
  })
})

describe('centroidMatch', () => {
  it('needs at least three picks — the UI unlocks at >=3 (V7)', () => {
    for (const count of [0, 1, MIN_SELECTION_PICKS - 1]) {
      expect(() => centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS.slice(0, count))).toThrow(
        /at least 3 picks/,
      )
    }
  })

  it('ranks the unpicked pastel above the terminal-mono distractor', () => {
    const matches = centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS)
    const ids = matches.map((m) => m.item.id)
    expect(ids.indexOf(PASTEL_D.id)).toBeLessThan(ids.indexOf(MONO_TERMINAL.id))
    const pastelDistance = matches.find((m) => m.item.id === PASTEL_D.id)!.distance
    const monoDistance = matches.find((m) => m.item.id === MONO_TERMINAL.id)!.distance
    expect(pastelDistance).toBeLessThan(monoDistance)
  })

  it('excludes picked items from the results entirely', () => {
    const matches = centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS)
    expect(matches.map((m) => m.item.id)).toEqual(expect.not.arrayContaining(PASTEL_PICKS))
  })

  it('returns the top-3 by default and honors a custom limit', () => {
    expect(centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS)).toHaveLength(3)
    expect(centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS, { limit: 1 })).toEqual([
      { item: PASTEL_D, distance: expect.any(Number) },
    ])
  })

  it('sorts strictly by distance, ties broken by item id', () => {
    const matches = centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS)
    for (let i = 1; i < matches.length; i++) {
      const prev = matches[i - 1]!
      const cur = matches[i]!
      expect(prev.distance).toBeLessThanOrEqual(cur.distance)
      if (prev.distance === cur.distance) expect(prev.item.id < cur.item.id).toBe(true)
    }
  })

  it('is deterministic', () => {
    expect(centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS)).toEqual(
      centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS),
    )
  })

  it('throws loud on duplicate picks and unknown pick ids', () => {
    expect(() => centroidMatch(TOY_INDEX, TOY_CORPUS, [PASTEL_A.id, PASTEL_A.id, PASTEL_B.id])).toThrow(
      /duplicate picked ids/,
    )
    expect(() =>
      centroidMatch(TOY_INDEX, TOY_CORPUS, [PASTEL_A.id, PASTEL_B.id, 'f0000000-0000-4000-8000-00000000000f']),
    ).toThrow(/not in the corpus vector index/)
  })

  it('throws loud on a non-positive or non-integer limit', () => {
    expect(() => centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS, { limit: 0 })).toThrow(/limit/)
    expect(() => centroidMatch(TOY_INDEX, TOY_CORPUS, PASTEL_PICKS, { limit: 1.5 })).toThrow(/limit/)
  })
})
