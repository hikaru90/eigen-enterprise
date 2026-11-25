import type { Workbook } from './workbook'
import { kid, kids, NS_A, REL_THEME } from './xml'

/**
 * DrawingML colours for charts (ECMA-376 Part 1 §20.1.2.3): the theme's
 * colour scheme by name, and the colour choices a chart's shape properties
 * write (`srgbClr`, `schemeClr`, `sysClr`, `prstClr` with the transforms
 * lumMod / lumOff / tint / shade / alpha). Results are `#RRGGBB`.
 */

export type Theme = Map<string, string>

/** The default Office theme's colours, used when the workbook has no theme part (Excel does the same). */
const OFFICE: Record<string, string> = {
  dk1: '000000',
  lt1: 'FFFFFF',
  dk2: '44546A',
  lt2: 'E7E6E6',
  accent1: '4472C4',
  accent2: 'ED7D31',
  accent3: 'A5A5A5',
  accent4: 'FFC000',
  accent5: '5B9BD5',
  accent6: '70AD47',
  hlink: '0563C1',
  folHlink: '954F72',
}

/** The workbook theme's colour scheme (dk1, lt1, accent1 … by name). */
export function themeOf(wb: Workbook): Theme {
  const out: Theme = new Map(Object.entries(OFFICE))
  const rel = wb.pkg
    .relationships(wb.part)
    .find((r) => r.type === REL_THEME && r.part && wb.pkg.has(r.part))
  if (!rel?.part) return out
  const scheme = wb.pkg.xml(rel.part).getElementsByTagNameNS(NS_A, 'clrScheme')[0]
  if (!scheme) return out
  for (const el of kids(scheme, undefined)) {
    const c = kids(el, undefined)[0]
    const hex =
      c?.localName === 'srgbClr' ? c.getAttribute('val') : (c?.getAttribute('lastClr') ?? null)
    if (hex && /^[0-9A-Fa-f]{6}$/.test(hex)) out.set(el.localName!, hex.toUpperCase())
  }
  return out
}

/** The scheme names a chart's `schemeClr` uses (tx1/bg1 map to dk1/lt1 under the default colour map). */
const SCHEME_ALIAS: Record<string, string> = { tx1: 'dk1', bg1: 'lt1', tx2: 'dk2', bg2: 'lt2' }

const PRESET: Record<string, string> = {
  black: '000000',
  white: 'FFFFFF',
  red: 'FF0000',
  green: '008000',
  blue: '0000FF',
  yellow: 'FFFF00',
  gray: '808080',
  grey: '808080',
  orange: 'FFA500',
  purple: '800080',
}

type Hsl = [number, number, number]

function toHsl(hex: string): Hsl {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  const l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  return [h, s, l]
}

function fromHsl([h, s, l]: Hsl): string {
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let rgb: number[]
  if (s === 0) rgb = [l, l, l]
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    rgb = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)]
  }
  return rgb.map((v) => hex2(Math.round(clamp01(v) * 255))).join('')
}

const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
const hex2 = (n: number) => n.toString(16).padStart(2, '0').toUpperCase()

/** Applies DrawingML colour transforms in document order (lumMod/lumOff in HSL lightness, tint/shade towards white/black). */
export function transform(hex: string, mods: Array<{ name: string; val: number }>): string {
  let out = hex
  for (const m of mods) {
    const v = m.val / 100_000
    if (m.name === 'lumMod' || m.name === 'lumOff') {
      const hsl = toHsl(out)
      hsl[2] = clamp01(m.name === 'lumMod' ? hsl[2] * v : hsl[2] + v)
      out = fromHsl(hsl)
    } else if (m.name === 'tint' || m.name === 'shade') {
      out = [0, 2, 4]
        .map((i) => {
          const c = parseInt(out.slice(i, i + 2), 16)
          return hex2(Math.round(m.name === 'shade' ? c * v : c + (255 - c) * (1 - v)))
        })
        .join('')
    }
  }
  return out
}

/** A DrawingML colour choice element (srgbClr …) as `#RRGGBB`, or null when it is not one this reads. */
export function colorOf(el: Element | null, theme: Theme): string | null {
  if (!el || el.namespaceURI !== NS_A) return null
  let base: string | null = null
  if (el.localName === 'srgbClr') base = el.getAttribute('val')
  else if (el.localName === 'schemeClr') {
    const n = el.getAttribute('val') ?? ''
    base = theme.get(SCHEME_ALIAS[n] ?? n) ?? null
  } else if (el.localName === 'sysClr') base = el.getAttribute('lastClr') ?? null
  else if (el.localName === 'prstClr') base = PRESET[el.getAttribute('val') ?? ''] ?? null
  else if (el.localName === 'scrgbClr') {
    const pct = (a: string) => Math.round(clamp01(Number(el.getAttribute(a) ?? 0) / 100_000) * 255)
    base = hex2(pct('r')) + hex2(pct('g')) + hex2(pct('b'))
  }
  if (!base || !/^[0-9A-Fa-f]{6}$/.test(base)) return null
  const mods = kids(el, undefined, NS_A)
    .filter((k) => ['lumMod', 'lumOff', 'tint', 'shade'].includes(k.localName!))
    .map((k) => ({ name: k.localName!, val: Number(k.getAttribute('val') ?? 0) }))
  return `#${transform(base.toUpperCase(), mods)}`
}

/** The colour of a `solidFill` child of `parent` (spPr, ln …): a colour, 'none' for noFill, or null (automatic). */
export function fillOf(parent: Element | null, theme: Theme): string | 'none' | null {
  if (!parent) return null
  if (kid(parent, 'noFill', NS_A)) return 'none'
  const solid = kid(parent, 'solidFill', NS_A)
  if (solid) return colorOf(kids(solid, undefined, NS_A)[0] ?? null, theme)
  const grad = kid(parent, 'gradFill', NS_A)
  // A gradient is drawn in its first stop's colour (gradients are not drawn here).
  const stop = grad ? grad.getElementsByTagNameNS(NS_A, 'gs')[0] : null
  if (stop) return colorOf(kids(stop, undefined, NS_A)[0] ?? null, theme)
  return null
}

/**
 * Excel's automatic series colours (chart style 2, the default): accent1–6
 * in turn; after six the cycle repeats darker, then lighter (lumMod/lumOff).
 */
export function autoColor(i: number, theme: Theme): string {
  const accent = theme.get(`accent${(i % 6) + 1}`) ?? OFFICE[`accent${(i % 6) + 1}`]!
  const cycle = Math.floor(i / 6) % 4
  const mods: Record<number, Array<{ name: string; val: number }>> = {
    0: [],
    1: [{ name: 'lumMod', val: 60_000 }],
    2: [
      { name: 'lumMod', val: 80_000 },
      { name: 'lumOff', val: 20_000 },
    ],
    3: [{ name: 'lumMod', val: 80_000 }],
  }
  return `#${transform(accent, mods[cycle]!)}`
}
