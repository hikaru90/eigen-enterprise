import { describe, expect, it } from 'vitest'
import { expandSeeds } from './expand'
import { applySeedEdit, DARK_PIN_PREFIX, type DraftWithPins } from './reseed'
import { validSeeds } from './seeds.spec'

type DraftFixture = DraftWithPins & {
  cssVars: Record<string, string>
  darkCssVars: Record<string, string>
}

function seedDraft(overrides: Partial<DraftFixture> = {}): DraftFixture {
  const seeds = validSeeds()
  const expanded = expandSeeds(seeds)
  return {
    seeds,
    pins: {},
    cssVars: expanded.cssVars,
    darkCssVars: expanded.darkCssVars,
    ...overrides,
  }
}

describe('applySeedEdit — seed propagation with pins (phase-2d M6/V3)', () => {
  it('throws loud when the draft has no seed block, directing to resolved editing', () => {
    const draft = seedDraft({ seeds: null })
    expect(() => applySeedEdit(draft, { neutralTintHue: 10 })).toThrow(
      /no seeds.*resolved values \(pins\)/,
    )
  })

  it('re-expands after a seed patch: ramp moves everywhere', () => {
    const draft = seedDraft()
    const result = applySeedEdit(draft, { seedColor: { h: 42 } })
    const expected = expandSeeds(validSeeds({ seedColor: { ...validSeeds().seedColor, h: 42 } }))
    expect(result.seeds.seedColor.h).toBe(42)
    expect(result.cssVars).toEqual(expected.cssVars)
    expect(result.darkCssVars).toEqual(expected.darkCssVars)
    // untouched seed dimensions keep their values (deep merge)
    expect(result.seeds.fonts).toEqual(validSeeds().fonts)
  })

  it('pins beat re-expansion: pinned keys survive a seed patch unchanged', () => {
    const draft = seedDraft({
      pins: { '--primary': 'PINNED-PRIMARY', [`${DARK_PIN_PREFIX}--background`]: 'PINNED-DARK-BG' },
    })
    const result = applySeedEdit(draft, { seedColor: { h: 42 } })
    expect(result.cssVars['--primary']).toBe('PINNED-PRIMARY')
    expect(result.darkCssVars['--background']).toBe('PINNED-DARK-BG')
    // every other accent-derived var moved with the ramp
    expect(result.cssVars['--secondary']).not.toBe(draft.cssVars['--secondary'])
    expect(result.pins).toEqual(draft.pins)
  })

  it('result is exactly expansion + pins, nothing else (no silent extras)', () => {
    const pins = { '--ring': 'PINNED-RING' }
    const result = applySeedEdit(seedDraft({ pins }), { chromaCurve: 'flat' })
    const expected = expandSeeds(validSeeds({ chromaCurve: 'flat' }))
    expect(result.cssVars).toEqual({ ...expected.cssVars, '--ring': 'PINNED-RING' })
    expect(result.darkCssVars).toEqual(expected.darkCssVars)
  })

  it('merges nested patches without dropping sibling seed values', () => {
    const result = applySeedEdit(seedDraft(), {
      fluidScale: { baseSize: { min: 17 } },
      fonts: { fontPrimary: 'Bitter' },
    })
    expect(result.seeds.fluidScale.baseSize).toEqual({ min: 17, max: 18 })
    expect(result.seeds.fluidScale.scaleRatio).toEqual(validSeeds().fluidScale.scaleRatio)
    expect(result.seeds.fonts.fontSecondary).toBe(validSeeds().fonts.fontSecondary)
    expect(result.seeds.fonts.fontPrimary).toBe('Bitter')
    expect(result.cssVars['--font-sans']).toBe('"Bitter"')
  })

  it('is deterministic: identical draft + patch always expand identically', () => {
    const draft = seedDraft({ pins: { '--primary': 'PINNED' } })
    expect(applySeedEdit(draft, { seedColor: { h: 7 } })).toEqual(
      applySeedEdit(draft, { seedColor: { h: 7 } }),
    )
  })

  it('does not mutate the draft it was given', () => {
    const draft = seedDraft()
    const before = structuredClone({ seeds: draft.seeds, cssVars: draft.cssVars })
    applySeedEdit(draft, { seedColor: { h: 42 } })
    expect({ seeds: draft.seeds, cssVars: draft.cssVars }).toEqual(before)
  })

  it('fails loud on a patch that violates the seed schema', () => {
    expect(() => applySeedEdit(seedDraft(), { grain: 42 })).toThrow(/grain/)
  })
})
