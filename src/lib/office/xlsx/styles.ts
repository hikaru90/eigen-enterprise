import { NS_A, NS_MAIN, insertInOrder, kid, kids, make, textOf } from './xml'

/**
 * The workbook's cell formats (styles part, ECMA-376 Part 1 §18.8): what the
 * grid draws (number format, font, fill, borders, alignment) and the number
 * format edit — a cell's number format, written as a copy of its format
 * record with only the number format changed, so everything else about the
 * cell's look stays. Font, fill, border and alignment edits: ./style-records.ts.
 */

export type FontStyle = {
  bold: boolean
  italic: boolean
  underline: boolean
  strike: boolean
  /** "#RRGGBB" or null (the default text colour). */
  color: string | null
  sizePt: number | null
  name: string | null
}

/** One edge of a cell's border: Excel's line style (thin, medium, dashed …) and colour ("#RRGGBB", null: automatic). */
export type BorderEdge = { style: string; color: string | null }
export type CellBorders = {
  left: BorderEdge | null
  right: BorderEdge | null
  top: BorderEdge | null
  bottom: BorderEdge | null
}

export type CellStyle = {
  numFmtId: number
  /** The format code; built-in id 14 (the short date) is resolved per locale when shown. */
  numFmt: string
  font: FontStyle
  fill: string | null
  border: CellBorders
  horizontal: string | null
  vertical: string | null
  wrap: boolean
  indent: number
}

export type Styles = {
  count: number
  xf(index: number): CellStyle
  /** The format code of a number format id (custom or built-in; unknown ids read General). */
  numFmtCode(id: number): string
}

/** Built-in number formats (§18.8.30). Id 14 is the locale's short date. */
export const BUILTIN_NUMFMT: Record<number, string> = {
  0: 'General',
  1: '0',
  2: '0.00',
  3: '#,##0',
  4: '#,##0.00',
  9: '0%',
  10: '0.00%',
  11: '0.00E+00',
  12: '# ?/?',
  13: '# ??/??',
  14: 'mm-dd-yy',
  15: 'd-mmm-yy',
  16: 'd-mmm',
  17: 'mmm-yy',
  18: 'h:mm AM/PM',
  19: 'h:mm:ss AM/PM',
  20: 'h:mm',
  21: 'h:mm:ss',
  22: 'm/d/yy h:mm',
  37: '#,##0 ;(#,##0)',
  38: '#,##0 ;[Red](#,##0)',
  39: '#,##0.00;(#,##0.00)',
  40: '#,##0.00;[Red](#,##0.00)',
  45: 'mm:ss',
  46: '[h]:mm:ss',
  47: 'mmss.0',
  48: '##0.0E+0',
  49: '@',
}

/** The legacy colour palette (§18.8.27); `<colors><indexedColors>` replaces it. */
const DEFAULT_INDEXED = [
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '000000',
  'FFFFFF',
  'FF0000',
  '00FF00',
  '0000FF',
  'FFFF00',
  'FF00FF',
  '00FFFF',
  '800000',
  '008000',
  '000080',
  '808000',
  '800080',
  '008080',
  'C0C0C0',
  '808080',
  '9999FF',
  '993366',
  'FFFFCC',
  'CCFFFF',
  '660066',
  'FF8080',
  '0066CC',
  'CCCCFF',
  '000080',
  'FF00FF',
  'FFFF00',
  '00FFFF',
  '800080',
  '800000',
  '008080',
  '0000FF',
  '00CCFF',
  'CCFFFF',
  'CCFFCC',
  'FFFF99',
  '99CCFF',
  'FF99CC',
  'CC99FF',
  'FFCC99',
  '3366FF',
  '33CCCC',
  '99CC00',
  'FFCC00',
  'FF9900',
  'FF6600',
  '666699',
  '969696',
  '003366',
  '339966',
  '003300',
  '333300',
  '993300',
  '993366',
  '333399',
  '333333',
]

export const STYLESHEET_ORDER = [
  'numFmts',
  'fonts',
  'fills',
  'borders',
  'cellStyleXfs',
  'cellXfs',
  'cellStyles',
  'dxfs',
  'tableStyles',
  'colors',
  'extLst',
] as const

const PLAIN_FONT: FontStyle = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: null,
  sizePt: null,
  name: null,
}
const NO_BORDER: CellBorders = { left: null, right: null, top: null, bottom: null }
const GENERAL: CellStyle = {
  numFmtId: 0,
  numFmt: 'General',
  font: PLAIN_FONT,
  fill: null,
  border: NO_BORDER,
  horizontal: null,
  vertical: null,
  wrap: false,
  indent: 0,
}

const flag = (el: Element | null) => {
  if (!el) return false
  const v = el.getAttribute('val')
  return v === null || v === '1' || v === 'true'
}

/** Theme colours in SpreadsheetML index order: lt1, dk1, lt2, dk2, accent1–6, hlink, folHlink. */
function themeColors(theme: XMLDocument | null): string[] {
  if (!theme) return []
  const scheme = theme.getElementsByTagNameNS(NS_A, 'clrScheme')[0]
  if (!scheme) return []
  const byName = new Map<string, string>()
  for (const el of kids(scheme, undefined)) {
    const c = kids(el, undefined)[0]
    const hex =
      c?.getAttribute('val') && c.localName === 'srgbClr'
        ? c.getAttribute('val')
        : c?.getAttribute('lastClr')
    if (hex) byName.set(el.localName!, hex.toUpperCase())
  }
  return [
    'lt1',
    'dk1',
    'lt2',
    'dk2',
    'accent1',
    'accent2',
    'accent3',
    'accent4',
    'accent5',
    'accent6',
    'hlink',
    'folHlink',
  ].map((n) => byName.get(n) ?? '')
}

/** Lightens (tint > 0) or darkens (tint < 0) a colour in HSL lightness, as §18.8.19 describes. */
function applyTint(hex: string, tint: number): string {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ]
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  let h = 0
  let s = 0
  let l = (max + min) / 2
  if (max !== min) {
    const d = max - min
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min)
    h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4
    h /= 6
  }
  l = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1
    if (t > 1) t -= 1
    if (t < 1 / 6) return p + (q - p) * 6 * t
    if (t < 1 / 2) return q
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6
    return p
  }
  let out: number[]
  if (s === 0) out = [l, l, l]
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s
    const p = 2 * l - q
    out = [hue(p, q, h + 1 / 3), hue(p, q, h), hue(p, q, h - 1 / 3)]
  }
  return out
    .map((v) =>
      Math.round(Math.max(0, Math.min(1, v)) * 255)
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')
    .toUpperCase()
}

/** Reads a SpreadsheetML colour element (rgb, theme + tint, indexed) as "#RRGGBB"; null: automatic. Also for conditional formats (./cond-format.ts). */
export function colorReader(
  doc: XMLDocument | null,
  theme: XMLDocument | null,
): (el: Element | null) => string | null {
  const root = doc?.documentElement ?? null
  const theme_ = themeColors(theme)
  const palette = (() => {
    const custom = root ? kid(root, 'colors') : null
    const idx = custom ? kid(custom, 'indexedColors') : null
    if (!idx) return DEFAULT_INDEXED
    return kids(idx, 'rgbColor').map((c) => (c.getAttribute('rgb') ?? '').slice(-6).toUpperCase())
  })()
  return (el: Element | null): string | null => {
    if (!el) return null
    const rgb = el.getAttribute('rgb')
    const themeIdx = el.getAttribute('theme')
    const indexed = el.getAttribute('indexed')
    let hex: string | null = null
    if (rgb) hex = rgb.slice(-6).toUpperCase()
    else if (themeIdx !== null) hex = theme_[Number(themeIdx)] || null
    else if (indexed !== null) {
      const i = Number(indexed)
      hex = i === 64 ? null : i === 65 ? 'FFFFFF' : (palette[i] ?? null)
    }
    if (!hex || !/^[0-9A-F]{6}$/.test(hex)) return null
    const tint = Number(el.getAttribute('tint') ?? 0)
    return `#${tint ? applyTint(hex, tint) : hex}`
  }
}

export function readStyles(doc: XMLDocument | null, theme: XMLDocument | null): Styles {
  if (!doc)
    return { count: 1, xf: () => GENERAL, numFmtCode: (id) => BUILTIN_NUMFMT[id] ?? 'General' }
  const root = doc.documentElement!
  const color = colorReader(doc, theme)
  const numFmts = new Map<number, string>()
  const nf = kid(root, 'numFmts')
  for (const el of nf ? kids(nf, 'numFmt') : [])
    numFmts.set(Number(el.getAttribute('numFmtId')), el.getAttribute('formatCode') ?? 'General')
  const fontsEl = kid(root, 'fonts')
  const fonts: FontStyle[] = (fontsEl ? kids(fontsEl, 'font') : []).map((f) => {
    const u = kid(f, 'u')
    const sz = kid(f, 'sz')?.getAttribute('val')
    return {
      bold: flag(kid(f, 'b')),
      italic: flag(kid(f, 'i')),
      underline: !!u && u.getAttribute('val') !== 'none',
      strike: flag(kid(f, 'strike')),
      color: color(kid(f, 'color')),
      sizePt: sz ? Number(sz) : null,
      name: kid(f, 'name')?.getAttribute('val') ?? null,
    }
  })
  const fillsEl = kid(root, 'fills')
  const fills: (string | null)[] = (fillsEl ? kids(fillsEl, 'fill') : []).map((f) => {
    const p = kid(f, 'patternFill')
    return p?.getAttribute('patternType') === 'solid' ? color(kid(p, 'fgColor')) : null
  })
  const bordersEl = kid(root, 'borders')
  const borders: CellBorders[] = (bordersEl ? kids(bordersEl, 'border') : []).map((b) => {
    const edge = (...names: string[]): BorderEdge | null => {
      const el = names.map((n) => kid(b, n)).find((e) => e !== null) ?? null
      const style = el?.getAttribute('style')
      return el && style && style !== 'none' ? { style, color: color(kid(el, 'color')) } : null
    }
    return {
      left: edge('left', 'start'),
      right: edge('right', 'end'),
      top: edge('top'),
      bottom: edge('bottom'),
    }
  })
  const xfsEl = kid(root, 'cellXfs')
  const xfs = xfsEl ? kids(xfsEl, 'xf') : []
  const cache = new Map<number, CellStyle>()
  return {
    count: Math.max(1, xfs.length),
    numFmtCode: (id) => numFmts.get(id) ?? BUILTIN_NUMFMT[id] ?? 'General',
    xf(index) {
      const hit = cache.get(index)
      if (hit) return hit
      const el = xfs[index]
      if (!el) return GENERAL
      const id = Number(el.getAttribute('numFmtId') ?? 0)
      const align = kid(el, 'alignment')
      const style: CellStyle = {
        numFmtId: id,
        numFmt: numFmts.get(id) ?? BUILTIN_NUMFMT[id] ?? 'General',
        font: fonts[Number(el.getAttribute('fontId') ?? 0)] ?? PLAIN_FONT,
        fill: fills[Number(el.getAttribute('fillId') ?? 0)] ?? null,
        border: borders[Number(el.getAttribute('borderId') ?? 0)] ?? NO_BORDER,
        horizontal: align?.getAttribute('horizontal') ?? null,
        vertical: align?.getAttribute('vertical') ?? null,
        wrap: align?.getAttribute('wrapText') === '1' || align?.getAttribute('wrapText') === 'true',
        indent: Number(align?.getAttribute('indent') ?? 0),
      }
      cache.set(index, style)
      return style
    },
  }
}

/** A minimal styles part (one font, the two required fills, one border, one format), for a workbook that has none. */
export const MINIMAL_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${NS_MAIN}"><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`

/**
 * The cellXfs index of format `xfIndex` with number format `code` (a copy of
 * that record with only the number format changed; an identical existing
 * record is reused). Edits `doc`, the styles part.
 */
export function xfWithNumFmt(doc: XMLDocument, xfIndex: number, code: string): number {
  const id = numFmtIdFor(doc, code)
  const xfsEl = ensureCellXfs(doc)
  const xfs = kids(xfsEl, 'xf')
  const base = xfs[xfIndex] ?? xfs[0]!
  if (Number(base.getAttribute('numFmtId') ?? 0) === id) return xfs[xfIndex] ? xfIndex : 0
  const copy = base.cloneNode(true) as Element
  copy.setAttribute('numFmtId', String(id))
  copy.setAttribute('applyNumberFormat', '1')
  const key = signature(copy)
  const same = xfs.findIndex((x) => signature(x) === key)
  if (same >= 0) return same
  xfsEl.appendChild(copy)
  xfsEl.setAttribute('count', String(xfs.length + 1))
  return xfs.length
}

/** The styles part's cell formats (cellXfs), made with the one plain record when it has none. */
export function ensureCellXfs(doc: XMLDocument): Element {
  const root = doc.documentElement!
  let xfsEl = kid(root, 'cellXfs')
  if (!xfsEl) {
    xfsEl = make(doc, 'cellXfs')
    const xf = make(doc, 'xf')
    for (const [k, v] of [
      ['numFmtId', '0'],
      ['fontId', '0'],
      ['fillId', '0'],
      ['borderId', '0'],
      ['xfId', '0'],
    ])
      xf.setAttribute(k!, v!)
    xfsEl.appendChild(xf)
    insertInOrder(root, xfsEl, STYLESHEET_ORDER)
  }
  return xfsEl
}

function signature(el: Element): string {
  const attrs: string[] = []
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]!
    attrs.push(`${a.name}=${a.value}`)
  }
  attrs.sort()
  return `${attrs.join(' ')}|${kids(el, undefined)
    .map((k) => {
      const ka: string[] = []
      for (let i = 0; i < k.attributes.length; i++)
        ka.push(`${k.attributes[i]!.name}=${k.attributes[i]!.value}`)
      return `${k.localName}(${ka.sort().join(' ')})${textOf(k)}`
    })
    .join(',')}`
}

/** The id of number format `code`: a built-in one, an existing custom one, else a new custom one (ids from 164). */
function numFmtIdFor(doc: XMLDocument, code: string): number {
  for (const [id, c] of Object.entries(BUILTIN_NUMFMT)) if (c === code) return Number(id)
  const root = doc.documentElement!
  let nf = kid(root, 'numFmts')
  const existing = nf ? kids(nf, 'numFmt') : []
  const hit = existing.find((e) => e.getAttribute('formatCode') === code)
  if (hit) return Number(hit.getAttribute('numFmtId'))
  const id = Math.max(163, ...existing.map((e) => Number(e.getAttribute('numFmtId')))) + 1
  if (!nf) {
    nf = make(doc, 'numFmts')
    insertInOrder(root, nf, STYLESHEET_ORDER)
  }
  const el = make(doc, 'numFmt')
  el.setAttribute('numFmtId', String(id))
  el.setAttribute('formatCode', code)
  nf.appendChild(el)
  nf.setAttribute('count', String(existing.length + 1))
  return id
}
