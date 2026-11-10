import sharp from 'sharp'
import { describe, expect, it } from 'vitest'
import { renderAppIcon } from './icon'

const colors = { tile: '#5b2a6e', glyph: '#ffffff', background: '#faf6ee' }

async function pixels(png: Buffer) {
  const { data, info } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const at = (x: number, y: number) => {
    const i = (y * info.width + x) * 4
    return { r: data[i], g: data[i + 1], b: data[i + 2], a: data[i + 3] }
  }
  let glyph = 0
  for (let i = 0; i < data.length; i += 4) if (data[i] > 240 && data[i + 1] > 240 && data[i + 2] > 240 && data[i + 3] > 240) glyph++
  return { info, at, glyphShare: glyph / (info.width * info.height) }
}

const TILE = { r: 0x5b, g: 0x2a, b: 0x6e, a: 255 }

describe('renderAppIcon', () => {
  it('draws the initial on the brand tile, at the requested size', async () => {
    const p = await pixels(await renderAppIcon({ initial: 'K', colors, kind: 'any', size: 192 }))
    expect([p.info.width, p.info.height]).toEqual([192, 192])
    expect(p.at(96, 20)).toEqual(TILE) // tile above the letter
    expect(p.glyphShare).toBeGreaterThan(0.03) // the letter is there
  })

  it('"any" icons have rounded corners; maskable and Apple icons are full-bleed (the OS shapes them)', async () => {
    const any = await pixels(await renderAppIcon({ initial: 'K', colors, kind: 'any', size: 512 }))
    expect(any.at(1, 1).a).toBe(0)
    for (const kind of ['maskable', 'apple'] as const) {
      const p = await pixels(await renderAppIcon({ initial: 'K', colors, kind, size: 512 }))
      expect(p.at(1, 1)).toEqual(TILE)
    }
  })

  it('keeps the letter inside the maskable safe zone', async () => {
    const p = await pixels(await renderAppIcon({ initial: 'W', colors, kind: 'maskable', size: 512 }))
    // Outside the central 80% circle there is only tile.
    for (const [x, y] of [[60, 256], [452, 256], [256, 60], [256, 452]]) expect(p.at(x, y)).toEqual(TILE)
  })

  it('draws Latin, Greek and Cyrillic initials; a script the font lacks gets the plain brand tile', async () => {
    for (const initial of ['Ö', 'Ω', 'Ж']) {
      const p = await pixels(await renderAppIcon({ initial, colors, kind: 'any', size: 192 }))
      expect(p.glyphShare).toBeGreaterThan(0.02)
    }
    const plain = await pixels(await renderAppIcon({ initial: '東', colors, kind: 'any', size: 192 }))
    expect(plain.glyphShare).toBe(0)
    expect(plain.at(96, 96)).toEqual(TILE)
  })
})
