import { DOMParser } from '@xmldom/xmldom'
import { describe, expect, it } from 'vitest'
import { parseColor, resolveColor, toCss, type ColorContext, type ColorSpec } from './color'
import { NS } from './xml'

function el(xml: string): Element {
  const doc = new DOMParser().parseFromString(`<root xmlns:a="${NS.a}">${xml}</root>`, 'application/xml')
  return doc.documentElement!.firstChild as unknown as Element
}

const THEME: Record<string, ColorSpec> = {
  dk1: { kind: 'sys', name: 'windowText', last: '000000', mods: [] },
  lt1: { kind: 'sys', name: 'window', last: 'FFFFFF', mods: [] },
  dk2: { kind: 'srgb', hex: '1F2A44', mods: [] },
  lt2: { kind: 'srgb', hex: 'E8E8E8', mods: [] },
  accent1: { kind: 'srgb', hex: '4472C4', mods: [] },
  accent2: { kind: 'srgb', hex: 'ED7D31', mods: [] },
}
const ctx = (over: Partial<ColorContext> = {}): ColorContext => ({
  theme: THEME,
  clrMap: { bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2', accent1: 'accent1', accent2: 'accent2' },
  ...over,
})
const rgb = (xml: string, c = ctx()) => resolveColor(parseColor(el(xml)), c)

describe('DrawingML colours (ECMA-376 §20.1.2.3)', () => {
  it('reads sRGB, preset, system (last colour), HSL and scRGB', () => {
    expect(rgb('<a:srgbClr val="FF8000"/>')).toEqual({ r: 255, g: 128, b: 0, a: 1 })
    expect(rgb('<a:prstClr val="dkGreen"/>')).toEqual({ r: 0, g: 100, b: 0, a: 1 })
    expect(rgb('<a:prstClr val="ltGray"/>')).toEqual({ r: 211, g: 211, b: 211, a: 1 })
    expect(rgb('<a:sysClr val="windowText" lastClr="112233"/>')).toEqual({ r: 0x11, g: 0x22, b: 0x33, a: 1 })
    expect(rgb('<a:hslClr hue="0" sat="100000" lum="50000"/>')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
    expect(rgb('<a:scrgbClr r="100000" g="0" b="0"/>')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })

  it('maps scheme names through the colour map (tx1 → dk1) before the theme', () => {
    expect(rgb('<a:schemeClr val="tx1"/>')).toEqual({ r: 0, g: 0, b: 0, a: 1 })
    expect(rgb('<a:schemeClr val="bg1"/>')).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    const swapped = ctx({ clrMap: { bg1: 'dk1', tx1: 'lt1' } })
    expect(rgb('<a:schemeClr val="tx1"/>', swapped)).toEqual({ r: 255, g: 255, b: 255, a: 1 })
    expect(rgb('<a:schemeClr val="accent2"/>')).toEqual({ r: 0xed, g: 0x7d, b: 0x31, a: 1 })
  })

  it('substitutes phClr with the style reference colour', () => {
    const phClr: ColorSpec = { kind: 'srgb', hex: '00FF00', mods: [] }
    expect(rgb('<a:schemeClr val="phClr"><a:shade val="50000"/></a:schemeClr>', ctx({ phClr }))).toEqual({ r: 0, g: 188, b: 0, a: 1 })
  })

  it('applies lumMod/lumOff in HSL (the "lighter 40%" theme variant)', () => {
    // accent1 4472C4, lumMod 60000 lumOff 40000
    expect(rgb('<a:schemeClr val="accent1"><a:lumMod val="60000"/><a:lumOff val="40000"/></a:schemeClr>')).toEqual({ r: 143, g: 170, b: 220, a: 1 })
    // darker 50%
    expect(rgb('<a:schemeClr val="accent1"><a:lumMod val="50000"/></a:schemeClr>')).toEqual({ r: 32, g: 56, b: 100, a: 1 })
  })

  it('applies tint and shade in linear RGB', () => {
    expect(rgb('<a:srgbClr val="808080"><a:shade val="50000"/></a:srgbClr>')).toEqual({ r: 92, g: 92, b: 92, a: 1 })
    expect(rgb('<a:srgbClr val="000000"><a:tint val="50000"/></a:srgbClr>')).toEqual({ r: 188, g: 188, b: 188, a: 1 })
    expect(rgb('<a:srgbClr val="FF0000"><a:tint val="100000"/></a:srgbClr>')).toEqual({ r: 255, g: 0, b: 0, a: 1 })
  })

  it('applies alpha, satMod, hueOff, comp, inv and gray', () => {
    expect(rgb('<a:srgbClr val="FF0000"><a:alpha val="25000"/></a:srgbClr>')).toEqual({ r: 255, g: 0, b: 0, a: 0.25 })
    expect(rgb('<a:srgbClr val="FF0000"><a:alpha val="50000"/><a:alphaMod val="50000"/></a:srgbClr>')?.a).toBe(0.25)
    expect(rgb('<a:hslClr hue="0" sat="100000" lum="50000"><a:satMod val="0"/></a:hslClr>')).toEqual({ r: 128, g: 128, b: 128, a: 1 })
    expect(rgb('<a:srgbClr val="FF0000"><a:hueOff val="7200000"/></a:srgbClr>')).toEqual({ r: 0, g: 255, b: 0, a: 1 })
    expect(rgb('<a:srgbClr val="FF0000"><a:comp/></a:srgbClr>')).toEqual({ r: 0, g: 255, b: 255, a: 1 })
    expect(rgb('<a:srgbClr val="FF0000"><a:inv/></a:srgbClr>')).toEqual({ r: 0, g: 255, b: 255, a: 1 })
    expect(rgb('<a:srgbClr val="FF0000"><a:gray/></a:srgbClr>')).toEqual({ r: 76, g: 76, b: 76, a: 1 })
  })

  it('formats CSS colours', () => {
    expect(toCss({ r: 1, g: 2, b: 3, a: 1 })).toBe('#010203')
    expect(toCss({ r: 255, g: 0, b: 0, a: 0.5 })).toBe('rgba(255,0,0,0.5)')
  })

  it('an unknown scheme name resolves to nothing rather than a guess', () => {
    expect(rgb('<a:schemeClr val="accent6"/>')).toBeNull()
  })
})
