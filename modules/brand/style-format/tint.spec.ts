import { describe, expect, it } from 'vitest'
import { parseMonochromeTint } from '../water-flow-shader'
import { grayscaleTint } from './tint'

describe('grayscaleTint', () => {
  it('passes already-gray hex through unchanged (byte-identical)', () => {
    expect(grayscaleTint('#060606')).toBe('#060606')
    expect(grayscaleTint('#b9b9b9')).toBe('#b9b9b9')
    expect(grayscaleTint('#fff')).toBe('#fff')
    expect(grayscaleTint(' #060606 ')).toBe('#060606')
  })

  it('projects a chromatic hex onto the L axis: chroma dropped, hex gray emitted', () => {
    const tinted = grayscaleTint('#ff2200')
    expect(tinted).toMatch(/^#[0-9a-f]{6}$/)
    const [r, g, b] = parseMonochromeTint(tinted)
    expect(r).toBe(g)
    expect(g).toBe(b)
    // A red-dominant color sits above mid gray on the L axis.
    expect(r).toBeGreaterThan(0.3)
  })

  it('keeps lightness of a chromatic oklch value: same L in, same gray out', () => {
    // L=0.5 with real chroma vs L=0.5 achromatic — both must land on the same gray.
    const chromatic = grayscaleTint('oklch(0.5 0.14 30)')
    const neutral = grayscaleTint('oklch(0.5 0 0)')
    expect(chromatic).toBe(neutral)
  })

  it('emits #rrggbb for achromatic oklch corpus-style values', () => {
    expect(grayscaleTint('oklch(0.962 0.0029 220)')).toMatch(/^#[0-9a-f]{6}$/)
    expect(grayscaleTint('oklch(1 0 0)')).toBe('#ffffff')
    expect(grayscaleTint('oklch(0 0 0)')).toBe('#000000')
  })

  it('round-trips every output through parseMonochromeTint (monochrome-compliant for the shader)', () => {
    const inputs = [
      '#060606',
      '#b9b9b9',
      '#ff2200',
      'oklch(0.247 0.006 220)',
      'oklch(0.962 0.0029 220)',
      'oklch(0.5 0.2 140)',
    ]
    for (const input of inputs) {
      const tinted = grayscaleTint(input)
      const [r, g, b] = parseMonochromeTint(tinted)
      expect(r).toBe(g)
      expect(g).toBe(b)
    }
  })

  it('clamps out-of-range lightness into the sRGB cube instead of emitting junk', () => {
    expect(grayscaleTint('oklch(1.4 0.1 90)')).toBe('#ffffff')
    expect(grayscaleTint('oklch(-0.2 0.1 90)')).toBe('#000000')
  })

  it('fails loud on non-color input (no silent fallback)', () => {
    expect(() => grayscaleTint('nonsense')).toThrow(/not a color/)
    expect(() => grayscaleTint('')).toThrow(/not a color/)
    expect(() => grayscaleTint('var(--background)')).toThrow(/not a color/)
  })
})
