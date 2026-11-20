import { isEl, NS } from './xml'

/**
 * DrawingML colours (ECMA-376 Part 1 §20.1.2.3): a base colour (sRGB, scRGB,
 * HSL, scheme, system or preset) plus an ordered list of transforms. Kept
 * unresolved in the model (a scheme colour follows the theme and colour map
 * of wherever it is drawn); `resolveColor` turns it into RGBA.
 */

export type ColorMod = { name: string; val: number | null }

export type ColorSpec =
  | { kind: 'srgb'; hex: string; mods: ColorMod[] }
  | { kind: 'scrgb'; r: number; g: number; b: number; mods: ColorMod[] }
  | { kind: 'hsl'; h: number; s: number; l: number; mods: ColorMod[] }
  | { kind: 'scheme'; name: string; mods: ColorMod[] }
  | { kind: 'sys'; name: string; last: string | null; mods: ColorMod[] }
  | { kind: 'preset'; name: string; mods: ColorMod[] }

/** 0–255 channels, alpha 0–1. */
export type Rgba = { r: number; g: number; b: number; a: number }

export type ColorContext = {
  /** The theme's colour scheme: dk1, lt1, dk2, lt2, accent1–6, hlink, folHlink. */
  theme: Record<string, ColorSpec>
  /** The effective colour map (master clrMap, or a slide/layout override): bg1 → lt1, tx1 → dk1, … */
  clrMap: Record<string, string>
  /** The colour a style reference puts in for `phClr` (§20.1.4.2). */
  phClr?: ColorSpec | null
}

const COLOR_ELEMENTS = new Set(['srgbClr', 'scrgbClr', 'hslClr', 'schemeClr', 'sysClr', 'prstClr'])

/** The first colour element among `el`'s children (e.g. inside a:solidFill), or null. */
export function colorIn(el: Element | null | undefined): ColorSpec | null {
  if (!el) return null
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (isEl(n) && n.namespaceURI === NS.a && COLOR_ELEMENTS.has(n.localName ?? '')) return parseColor(n)
  }
  return null
}

const num = (el: Element, name: string) => {
  const v = el.getAttribute(name)
  if (v === null || v === '') return 0
  return v.endsWith('%') ? Number(v.slice(0, -1)) * 1000 : Number(v)
}

export function parseColor(el: Element): ColorSpec {
  const mods: ColorMod[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (!isEl(n) || n.namespaceURI !== NS.a) continue
    const v = n.getAttribute('val')
    mods.push({ name: n.localName ?? '', val: v === null || v === '' ? null : v.endsWith('%') ? Number(v.slice(0, -1)) * 1000 : Number(v) })
  }
  switch (el.localName) {
    case 'srgbClr':
      return { kind: 'srgb', hex: (el.getAttribute('val') ?? '000000').toUpperCase(), mods }
    case 'scrgbClr':
      return { kind: 'scrgb', r: num(el, 'r'), g: num(el, 'g'), b: num(el, 'b'), mods }
    case 'hslClr':
      return { kind: 'hsl', h: num(el, 'hue'), s: num(el, 'sat'), l: num(el, 'lum'), mods }
    case 'schemeClr':
      return { kind: 'scheme', name: el.getAttribute('val') ?? '', mods }
    case 'sysClr':
      return { kind: 'sys', name: el.getAttribute('val') ?? '', last: el.getAttribute('lastClr') || null, mods }
    case 'prstClr':
      return { kind: 'preset', name: el.getAttribute('val') ?? '', mods }
    default:
      throw new Error(`Not a DrawingML colour element: ${el.localName}`)
  }
}

/** Names the colour map translates (ST_ColorSchemeIndex targets come from these). */
const MAPPED = new Set(['bg1', 'tx1', 'bg2', 'tx2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'])

/**
 * Windows' default system colours, for a sysClr written without its
 * lastClr (§20.1.10.58 names the values; the writer normally records them).
 */
const SYSTEM: Record<string, string> = {
  windowText: '000000', window: 'FFFFFF', btnFace: 'F0F0F0', btnText: '000000', btnShadow: 'A0A0A0',
  btnHighlight: 'FFFFFF', highlight: '0078D7', highlightText: 'FFFFFF', grayText: '6D6D6D', menu: 'F0F0F0',
  menuText: '000000', menuBar: 'F0F0F0', menuHighlight: '3399FF', captionText: '000000', infoBk: 'FFFFE1',
  infoText: '000000', '3dDkShadow': '696969', '3dLight': 'E3E3E3', background: '000000', appWorkspace: 'ABABAB',
  windowFrame: '646464', scrollBar: 'C8C8C8', activeBorder: 'B4B4B4', inactiveBorder: 'F4F7FC',
  activeCaption: '99B4D1', inactiveCaption: 'BFCDDB', inactiveCaptionText: '000000', hotLight: '0066CC',
  gradientActiveCaption: 'B9D1EA', gradientInactiveCaption: 'D7E4F2',
}

/** CSS Color 4 named colours; ST_PresetColorVal uses the same names (dk/lt/med prefixes spelled short). */
const NAMED = `aliceblue f0f8ff antiquewhite faebd7 aqua 00ffff aquamarine 7fffd4 azure f0ffff beige f5f5dc bisque ffe4c4
black 000000 blanchedalmond ffebcd blue 0000ff blueviolet 8a2be2 brown a52a2a burlywood deb887 cadetblue 5f9ea0
chartreuse 7fff00 chocolate d2691e coral ff7f50 cornflowerblue 6495ed cornsilk fff8dc crimson dc143c cyan 00ffff
darkblue 00008b darkcyan 008b8b darkgoldenrod b8860b darkgray a9a9a9 darkgrey a9a9a9 darkgreen 006400 darkkhaki bdb76b
darkmagenta 8b008b darkolivegreen 556b2f darkorange ff8c00 darkorchid 9932cc darkred 8b0000 darksalmon e9967a
darkseagreen 8fbc8f darkslateblue 483d8b darkslategray 2f4f4f darkslategrey 2f4f4f darkturquoise 00ced1
darkviolet 9400d3 deeppink ff1493 deepskyblue 00bfff dimgray 696969 dimgrey 696969 dodgerblue 1e90ff firebrick b22222
floralwhite fffaf0 forestgreen 228b22 fuchsia ff00ff gainsboro dcdcdc ghostwhite f8f8ff gold ffd700 goldenrod daa520
gray 808080 grey 808080 green 008000 greenyellow adff2f honeydew f0fff0 hotpink ff69b4 indianred cd5c5c indigo 4b0082
ivory fffff0 khaki f0e68c lavender e6e6fa lavenderblush fff0f5 lawngreen 7cfc00 lemonchiffon fffacd lightblue add8e6
lightcoral f08080 lightcyan e0ffff lightgoldenrodyellow fafad2 lightgray d3d3d3 lightgrey d3d3d3 lightgreen 90ee90
lightpink ffb6c1 lightsalmon ffa07a lightseagreen 20b2aa lightskyblue 87cefa lightslategray 778899
lightslategrey 778899 lightsteelblue b0c4de lightyellow ffffe0 lime 00ff00 limegreen 32cd32 linen faf0e6
magenta ff00ff maroon 800000 mediumaquamarine 66cdaa mediumblue 0000cd mediumorchid ba55d3 mediumpurple 9370db
mediumseagreen 3cb371 mediumslateblue 7b68ee mediumspringgreen 00fa9a mediumturquoise 48d1cc mediumvioletred c71585
midnightblue 191970 mintcream f5fffa mistyrose ffe4e1 moccasin ffe4b5 navajowhite ffdead navy 000080 oldlace fdf5e6
olive 808000 olivedrab 6b8e23 orange ffa500 orangered ff4500 orchid da70d6 palegoldenrod eee8aa palegreen 98fb98
paleturquoise afeeee palevioletred db7093 papayawhip ffefd5 peachpuff ffdab9 peru cd853f pink ffc0cb plum dda0dd
powderblue b0e0e6 purple 800080 red ff0000 rosybrown bc8f8f royalblue 4169e1 saddlebrown 8b4513 salmon fa8072
sandybrown f4a460 seagreen 2e8b57 seashell fff5ee sienna a0522d silver c0c0c0 skyblue 87ceeb slateblue 6a5acd
slategray 708090 slategrey 708090 snow fffafa springgreen 00ff7f steelblue 4682b4 tan d2b48c teal 008080 thistle d8bfd8
tomato ff6347 turquoise 40e0d0 violet ee82ee wheat f5deb3 white ffffff whitesmoke f5f5f5 yellow ffff00
yellowgreen 9acd32`
  .split(/\s+/)
  .reduce<Record<string, string>>((acc, tok, i, all) => {
    if (i % 2 === 0) acc[tok] = all[i + 1]!
    return acc
  }, {})

function presetHex(name: string): string | null {
  const css = name
    .replace(/^dk/, 'dark')
    .replace(/^lt/, 'light')
    .replace(/^med/, 'medium')
    .toLowerCase()
  return NAMED[css] ?? null
}

type Rgbf = { r: number; g: number; b: number; a: number } // 0–1

const hexToRgbf = (hex: string): Rgbf | null => {
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) return null
  const n = parseInt(hex, 16)
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255, a: 1 }
}

const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
const toSrgb = (c: number) => (c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055)
const clamp01 = (v: number) => Math.min(1, Math.max(0, v))

function rgbToHsl({ r, g, b }: Rgbf): [number, number, number] {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const l = (max + min) / 2
  const d = max - min
  if (d === 0) return [0, 0, l]
  const s = d / (1 - Math.abs(2 * l - 1))
  let h: number
  if (max === r) h = ((g - b) / d) % 6
  else if (max === g) h = (b - r) / d + 2
  else h = (r - g) / d + 4
  h *= 60
  if (h < 0) h += 360
  return [h, s, l]
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgbf {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  const [r1, g1, b1] =
    hp < 1 ? [c, x, 0] : hp < 2 ? [x, c, 0] : hp < 3 ? [0, c, x] : hp < 4 ? [0, x, c] : hp < 5 ? [x, 0, c] : [c, 0, x]
  const m = l - c / 2
  return { r: r1 + m, g: g1 + m, b: b1 + m, a }
}

function base(spec: ColorSpec, ctx: ColorContext, depth: number): Rgbf | null {
  switch (spec.kind) {
    case 'srgb':
      return hexToRgbf(spec.hex)
    case 'scrgb':
      return { r: toSrgb(clamp01(spec.r / 100000)), g: toSrgb(clamp01(spec.g / 100000)), b: toSrgb(clamp01(spec.b / 100000)), a: 1 }
    case 'hsl':
      return hslToRgb(spec.h / 60000, clamp01(spec.s / 100000), clamp01(spec.l / 100000), 1)
    case 'sys':
      return hexToRgbf(spec.last ?? SYSTEM[spec.name] ?? '')
    case 'preset': {
      const hex = presetHex(spec.name)
      return hex ? hexToRgbf(hex) : null
    }
    case 'scheme': {
      if (depth > 4) return null
      if (spec.name === 'phClr') return ctx.phClr ? resolveRgbf(ctx.phClr, { ...ctx, phClr: null }, depth + 1) : null
      const mapped = MAPPED.has(spec.name) ? (ctx.clrMap[spec.name] ?? spec.name) : spec.name
      const themed = ctx.theme[mapped]
      return themed ? resolveRgbf(themed, ctx, depth + 1) : null
    }
  }
}

function applyMods(c: Rgbf, mods: ColorMod[]): Rgbf {
  let { r, g, b, a } = c
  for (const { name, val } of mods) {
    const f = (val ?? 0) / 100000
    switch (name) {
      case 'alpha':
        a = clamp01(f)
        break
      case 'alphaMod':
        a = clamp01(a * f)
        break
      case 'alphaOff':
        a = clamp01(a + f)
        break
      case 'red':
        r = clamp01(toSrgb(f))
        break
      case 'redMod':
        r = clamp01(toSrgb(toLinear(r) * f))
        break
      case 'redOff':
        r = clamp01(toSrgb(toLinear(r) + f))
        break
      case 'green':
        g = clamp01(toSrgb(f))
        break
      case 'greenMod':
        g = clamp01(toSrgb(toLinear(g) * f))
        break
      case 'greenOff':
        g = clamp01(toSrgb(toLinear(g) + f))
        break
      case 'blue':
        b = clamp01(toSrgb(f))
        break
      case 'blueMod':
        b = clamp01(toSrgb(toLinear(b) * f))
        break
      case 'blueOff':
        b = clamp01(toSrgb(toLinear(b) + f))
        break
      case 'tint': {
        // Lighter: toward white in linear RGB (0 = white, 100000 = unchanged).
        const t = (v: number) => toSrgb(1 - (1 - toLinear(v)) * clamp01(f))
        r = t(r)
        g = t(g)
        b = t(b)
        break
      }
      case 'shade': {
        // Darker: toward black in linear RGB.
        const s = (v: number) => toSrgb(toLinear(v) * clamp01(f))
        r = s(r)
        g = s(g)
        b = s(b)
        break
      }
      case 'gamma':
        r = toSrgb(r)
        g = toSrgb(g)
        b = toSrgb(b)
        break
      case 'invGamma':
        r = toLinear(r)
        g = toLinear(g)
        b = toLinear(b)
        break
      case 'inv':
        r = 1 - r
        g = 1 - g
        b = 1 - b
        break
      case 'gray': {
        const y = 0.299 * r + 0.587 * g + 0.114 * b
        r = g = b = y
        break
      }
      case 'hue':
      case 'hueMod':
      case 'hueOff':
      case 'sat':
      case 'satMod':
      case 'satOff':
      case 'lum':
      case 'lumMod':
      case 'lumOff':
      case 'comp': {
        let [h, s, l] = rgbToHsl({ r, g, b, a })
        const deg = (val ?? 0) / 60000
        if (name === 'hue') h = deg
        else if (name === 'hueMod') h = h * f
        else if (name === 'hueOff') h = h + deg
        else if (name === 'sat') s = f
        else if (name === 'satMod') s = s * f
        else if (name === 'satOff') s = s + f
        else if (name === 'lum') l = f
        else if (name === 'lumMod') l = l * f
        else if (name === 'lumOff') l = l + f
        else h = h + 180
        ;({ r, g, b } = hslToRgb(h, clamp01(s), clamp01(l), a))
        break
      }
      default:
        // Unknown transform (a future schema's): ignored, the base colour stays.
        break
    }
  }
  return { r: clamp01(r), g: clamp01(g), b: clamp01(b), a }
}

function resolveRgbf(spec: ColorSpec, ctx: ColorContext, depth: number): Rgbf | null {
  const b = base(spec, ctx, depth)
  return b ? applyMods(b, spec.mods) : null
}

/** The colour as RGBA, or null when it names something the context does not have. */
export function resolveColor(spec: ColorSpec | null | undefined, ctx: ColorContext): Rgba | null {
  if (!spec) return null
  const c = resolveRgbf(spec, ctx, 0)
  if (!c) return null
  return { r: Math.round(c.r * 255), g: Math.round(c.g * 255), b: Math.round(c.b * 255), a: Math.round(c.a * 100000) / 100000 }
}

/** A transform added to a colour (lighten/darken path fills, bullets). */
export function withMod(spec: ColorSpec, mod: ColorMod): ColorSpec {
  return { ...spec, mods: [...spec.mods, mod] } as ColorSpec
}

export function toCss(c: Rgba): string {
  if (c.a >= 1) return `#${[c.r, c.g, c.b].map((v) => v.toString(16).padStart(2, '0')).join('')}`
  return `rgba(${c.r},${c.g},${c.b},${c.a})`
}
