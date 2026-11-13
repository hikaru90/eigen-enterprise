import { describe, expect, it } from 'vitest'
import { MATERIAL_KINDS, formatById, formatsOf, sizeLabel } from './formats'

describe('brand material formats', () => {
  it('offers flyer, banner, poster and merch, in that order', () => {
    expect(MATERIAL_KINDS.map((k) => k.id)).toEqual(['flyer', 'banner', 'poster', 'merch'])
  })

  it('every kind has at least one format; ids are unique', () => {
    const ids = MATERIAL_KINDS.flatMap((k) => formatsOf(k.id).map((f) => f.id))
    for (const k of MATERIAL_KINDS) expect(formatsOf(k.id).length).toBeGreaterThan(0)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('the flyer stays one A5 portrait format', () => {
    expect(formatsOf('flyer')).toEqual([
      { id: 'flyer-a5', kind: 'flyer', label: 'A5 flyer', width: 148, height: 210, unit: 'mm' },
    ])
  })

  it('banners: a landscape social header and a portrait roll-up', () => {
    const [social, rollup] = formatsOf('banner')
    expect(social).toMatchObject({ id: 'banner-social', width: 1500, height: 500, unit: 'px' })
    expect(rollup).toMatchObject({ id: 'banner-rollup', width: 850, height: 2000, unit: 'mm' })
  })

  it('trade-fair posters in A1 and A2 portrait', () => {
    expect(formatsOf('poster').map((f) => [f.id, f.width, f.height, f.unit])).toEqual([
      ['poster-a1', 594, 841, 'mm'],
      ['poster-a2', 420, 594, 'mm'],
    ])
  })

  it('merch: T-shirt, mug wrap and tote bag print areas', () => {
    expect(formatsOf('merch').map((f) => f.id)).toEqual(['merch-shirt', 'merch-mug', 'merch-tote'])
    expect(formatById('merch-mug')).toMatchObject({ width: 200, height: 90, unit: 'mm' })
  })

  it('formatById fails loud on an unknown id', () => {
    expect(() => formatById('nope')).toThrow('unknown material format: nope')
  })

  it('sizeLabel prints width × height with the unit', () => {
    expect(sizeLabel(formatById('poster-a1'))).toBe('594 × 841 mm')
    expect(sizeLabel(formatById('banner-social'))).toBe('1500 × 500 px')
  })
})
