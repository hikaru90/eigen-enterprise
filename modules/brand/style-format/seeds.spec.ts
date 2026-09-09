import { describe, expect, it } from 'vitest'
import {
  brandSeedsSchema,
  SEED_SHAPE_DESCRIPTION,
  type BrandSeeds,
} from './seeds'

export function validSeeds(overrides: Partial<BrandSeeds> = {}): BrandSeeds {
  return {
    seedColor: { l: 0.55, c: 0.14, h: 152 },
    neutralTintHue: 152,
    accentHueShift: 24,
    chromaCurve: 'tailwind',
    darkModeStrategy: 'invert-tone',
    fonts: {
      fontPrimary: 'Inter',
      fontSecondary: 'UnifrakturMaguntia',
      fontMono: 'Geist Mono',
    },
    fluidScale: {
      baseSize: { min: 16, max: 18 },
      scaleRatio: { min: 1.125, max: 1.2 },
      viewport: { min: 400, max: 1200 },
      scaleSteps: 5,
      trackingCurve: 'negative-on-display',
    },
    spaceRhythm: [0.25, 0.5, 1, 1.5, 2],
    shapeCharacter: 'soft',
    radiusBase: '0.5rem',
    elevation: 'subtle',
    motionPersonality: 'productive',
    grain: 0.04,
    ...overrides,
  }
}

describe('brandSeedsSchema', () => {
  it('accepts a valid seed block', () => {
    expect(brandSeedsSchema.safeParse(validSeeds()).success).toBe(true)
  })

  it('accepts null accentHueShift and optional imageryDirection', () => {
    const seeds = validSeeds({
      accentHueShift: null,
      imageryDirection: { style: 'editorial photography, natural light' },
    })
    expect(brandSeedsSchema.safeParse(seeds).success).toBe(true)
  })

  const table: Array<[string, (s: BrandSeeds) => BrandSeeds]> = [
    ['seedColor l below 0', (s) => ({ ...s, seedColor: { ...s.seedColor, l: -0.1 } })],
    ['seedColor c above 0.4', (s) => ({ ...s, seedColor: { ...s.seedColor, c: 0.5 } })],
    ['seedColor h above 360', (s) => ({ ...s, seedColor: { ...s.seedColor, h: 361 } })],
    ['neutralTintHue above 360', (s) => ({ ...s, neutralTintHue: 400 })],
    ['unknown chromaCurve', (s) => ({ ...s, chromaCurve: 'neon' as BrandSeeds['chromaCurve'] })],
    ['unknown darkModeStrategy', (s) => ({ ...s, darkModeStrategy: 'solarized' as BrandSeeds['darkModeStrategy'] })],
    ['empty font name', (s) => ({ ...s, fonts: { ...s.fonts, fontPrimary: '' } })],
    ['baseSize inverted', (s) => ({ ...s, fluidScale: { ...s.fluidScale, baseSize: { min: 20, max: 16 } } })],
    ['scaleRatio not > 1', (s) => ({ ...s, fluidScale: { ...s.fluidScale, scaleRatio: { min: 1, max: 1.2 } } })],
    ['viewport not increasing', (s) => ({ ...s, fluidScale: { ...s.fluidScale, viewport: { min: 1200, max: 400 } } })],
    ['scaleSteps below 4', (s) => ({ ...s, fluidScale: { ...s.fluidScale, scaleSteps: 3 } })],
    ['scaleSteps above 8', (s) => ({ ...s, fluidScale: { ...s.fluidScale, scaleSteps: 9 } })],
    ['scaleSteps non-integer', (s) => ({ ...s, fluidScale: { ...s.fluidScale, scaleSteps: 5.5 } })],
    ['unknown trackingCurve', (s) => ({ ...s, fluidScale: { ...s.fluidScale, trackingCurve: 'wild' as BrandSeeds['fluidScale']['trackingCurve'] } })],
    ['spaceRhythm too short', (s) => ({ ...s, spaceRhythm: [1, 2] })],
    ['spaceRhythm too long', (s) => ({ ...s, spaceRhythm: [1, 1, 1, 1, 1, 1, 1, 1, 1] })],
    ['spaceRhythm non-positive', (s) => ({ ...s, spaceRhythm: [0, 1, 2, 3] })],
    ['unknown shapeCharacter', (s) => ({ ...s, shapeCharacter: 'round' as BrandSeeds['shapeCharacter'] })],
    ['radiusBase not a css length', (s) => ({ ...s, radiusBase: 'big' })],
    ['unknown elevation', (s) => ({ ...s, elevation: 'sky' as BrandSeeds['elevation'] })],
    ['unknown motionPersonality', (s) => ({ ...s, motionPersonality: 'sleepy' as BrandSeeds['motionPersonality'] })],
    ['grain above 1', (s) => ({ ...s, grain: 1.5 })],
    ['grain below 0', (s) => ({ ...s, grain: -0.1 })],
  ]

  for (const [name, mutate] of table) {
    it(`rejects ${name}`, () => {
      expect(brandSeedsSchema.safeParse(mutate(validSeeds())).success).toBe(false)
    })
  }

  it('exposes a plain-JSON shape description for the LLM prompt', () => {
    expect(SEED_SHAPE_DESCRIPTION.type).toBe('object')
    expect(Object.keys(SEED_SHAPE_DESCRIPTION.properties)).toContain('seedColor')
    expect(JSON.parse(JSON.stringify(SEED_SHAPE_DESCRIPTION))).toEqual(SEED_SHAPE_DESCRIPTION)
  })
})
