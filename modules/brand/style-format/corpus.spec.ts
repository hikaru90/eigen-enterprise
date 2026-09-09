import { describe, expect, it } from 'vitest'
import { corpusItemSchema, validateCorpusItem, type BrandCorpusItem } from './corpus'
import { brandSeedsSchema } from './seeds'

const seeds = brandSeedsSchema.parse({
  seedColor: { l: 0.55, c: 0.14, h: 152 },
  neutralTintHue: 152,
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
  shapeCharacter: 'sharp',
  radiusBase: '0px',
  elevation: 'flat',
  motionPersonality: 'expressive',
  grain: 0,
})

function corpusItem(overrides: Partial<BrandCorpusItem> = {}): BrandCorpusItem {
  return {
    id: '0b8f8d9e-6a1e-4b3e-9c2f-1a2b3c4d5e6f',
    name: 'Kindred web',
    seeds,
    cssVars: { '--background': 'oklch(0.985 0.01 152)' },
    darkCssVars: { '--background': 'oklch(0.13 0.01 152)' },
    provenance: { source: 'extraction', url: 'https://example.com', capturedAt: '2026-09-09T00:00:00.000Z' },
    createdAt: '2026-09-09T00:00:00.000Z',
    ...overrides,
  }
}

describe('corpusItemSchema', () => {
  it('accepts a valid corpus item', () => {
    expect(corpusItemSchema.safeParse(corpusItem()).success).toBe(true)
  })

  it('rejects an unknown provenance source', () => {
    const bad = corpusItem({
      provenance: { source: 'vibes' as BrandCorpusItem['provenance']['source'] },
    })
    expect(corpusItemSchema.safeParse(bad).success).toBe(false)
  })

  it('rejects non-uuid ids and invalid seeds', () => {
    expect(corpusItemSchema.safeParse(corpusItem({ id: 'not-a-uuid' })).success).toBe(false)
    expect(
      corpusItemSchema.safeParse(corpusItem({ seeds: { ...seeds, grain: 9 } })).success,
    ).toBe(false)
  })
})

describe('validateCorpusItem', () => {
  it('returns the parsed item on success and throws loud on failure', () => {
    expect(validateCorpusItem(corpusItem()).name).toBe('Kindred web')
    expect(() => validateCorpusItem({ ...corpusItem(), name: '' })).toThrow(/name/i)
  })
})
