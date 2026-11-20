import { attr, emuPt, halfPointsPt, hexColor, intOr, NS, onOff, twipsPt, wa, wc, wcs } from './xml'

/**
 * Run, paragraph, table, row and cell properties (ECMA-376 Part 1 §17.3,
 * §17.4) parsed from their *Pr elements into plain objects. Every field is
 * optional: absent means "not set at this level", so layers (document
 * defaults → styles → numbering → direct formatting) merge field by field.
 */

export type Fonts = { ascii?: string; hAnsi?: string; eastAsia?: string; cs?: string }

/** A border edge; `none` set explicitly (w:val="nil"/"none") overrides an inherited one. */
export type Border = { style: string; widthPt: number; color: string | null; spacePt: number }

export type RunProps = {
  bold?: boolean
  boldCs?: boolean
  italic?: boolean
  italicCs?: boolean
  caps?: boolean
  smallCaps?: boolean
  strike?: boolean
  doubleStrike?: boolean
  /** Hidden text (w:vanish): Word does not show it, nor do we. */
  vanish?: boolean
  /** ST_Underline (single, double, thick, dotted, dash, wave, words, none, …). */
  underline?: string
  underlineColor?: string | null
  sizePt?: number
  sizeCsPt?: number
  /** null = automatic colour. */
  color?: string | null
  /** ST_HighlightColor name, or "none". */
  highlight?: string
  shading?: string | null
  fonts?: Fonts
  vertAlign?: 'superscript' | 'subscript' | 'baseline'
  rtl?: boolean
  /** Complex-script formatting applies (w:cs). */
  cs?: boolean
  spacingPt?: number
  positionPt?: number
  scalePct?: number
  lang?: { val?: string; eastAsia?: string; bidi?: string }
  border?: Border
}

export type LineSpacing = { rule: 'auto'; multiple: number } | { rule: 'exact' | 'atLeast'; pt: number }

export type TabStop = {
  /** Logical: start/end follow the paragraph's direction. */
  align: 'start' | 'center' | 'end' | 'decimal' | 'bar' | 'num' | 'clear'
  posPt: number
  leader: 'none' | 'dot' | 'hyphen' | 'underscore' | 'heavy' | 'middleDot'
}

export type ParagraphBorders = { top?: Border; bottom?: Border; start?: Border; end?: Border; between?: Border }

export type ParagraphProps = {
  styleId?: string
  /** Logical alignment: w:jc left/start → start, right/end → end, both → justify. */
  align?: 'start' | 'end' | 'center' | 'justify' | 'distribute'
  /** Logical indents in points; firstLinePt < 0 is a hanging indent. */
  indent?: { startPt?: number; endPt?: number; firstLinePt?: number }
  spacing?: { beforePt?: number; afterPt?: number; beforeAuto?: boolean; afterAuto?: boolean; line?: LineSpacing }
  contextualSpacing?: boolean
  keepNext?: boolean
  keepLines?: boolean
  pageBreakBefore?: boolean
  widowControl?: boolean
  bidi?: boolean
  tabs?: TabStop[]
  /** w:outlineLvl 0–8 (9 = body text). */
  outlineLevel?: number
  numbering?: { numId: string; ilvl?: number }
  shading?: string | null
  borders?: ParagraphBorders
  /** The paragraph mark's run properties (w:pPr/w:rPr). */
  markRun?: RunProps
}

export type EdgeBorders = { top?: Border; bottom?: Border; start?: Border; end?: Border; insideH?: Border; insideV?: Border }
export type Margins = { topPt?: number; bottomPt?: number; startPt?: number; endPt?: number }
/** A table width: twips/points ('pt'), percent of the available width ('pct'), or automatic. */
export type TableWidth = { type: 'pt'; value: number } | { type: 'pct'; value: number } | { type: 'auto' }

export type TableLook = {
  firstRow: boolean
  lastRow: boolean
  firstColumn: boolean
  lastColumn: boolean
  noHBand: boolean
  noVBand: boolean
}

export type TableProps = {
  styleId?: string
  width?: TableWidth
  align?: 'start' | 'center' | 'end'
  indentPt?: number
  borders?: EdgeBorders
  cellMargins?: Margins
  layout?: 'fixed' | 'autofit'
  shading?: string | null
  bidiVisual?: boolean
  look?: TableLook
  rowBandSize?: number
  colBandSize?: number
  cellSpacingPt?: number
}

export type RowProps = {
  heightPt?: number
  heightRule?: 'auto' | 'atLeast' | 'exact'
  header?: boolean
  cantSplit?: boolean
  gridBefore?: number
  gridAfter?: number
}

export type CellProps = {
  width?: TableWidth
  span?: number
  vMerge?: 'restart' | 'continue'
  borders?: EdgeBorders
  shading?: string | null
  margins?: Margins
  vAlign?: 'top' | 'center' | 'bottom'
  textDirection?: string
  noWrap?: boolean
}

/** The theme's major/minor fonts (a:fontScheme), for w:rFonts *Theme attributes. */
export type ThemeFonts = {
  major: { latin?: string; ea?: string; cs?: string }
  minor: { latin?: string; ea?: string; cs?: string }
}

export const EMPTY_THEME_FONTS: ThemeFonts = { major: {}, minor: {} }

// ---------------------------------------------------------------- borders / shading

export function parseBorder(el: Element | null): Border | undefined {
  if (!el) return undefined
  const style = wa(el, 'val') ?? 'single'
  if (style === 'nil' || style === 'none') return { style: 'none', widthPt: 0, color: null, spacePt: 0 }
  // w:sz: eighths of a point (§17.18.2 ST_EighthPointMeasure); art borders use points but we draw them plain.
  const sz = intOr(wa(el, 'sz'))
  return { style, widthPt: sz === null ? 0.5 : sz / 8, color: hexColor(wa(el, 'color')), spacePt: intOr(wa(el, 'space')) ?? 0 }
}

/** w:shd (§17.3.5): the fill, or the pattern colour for a solid pattern. */
export function parseShading(el: Element | null): string | null | undefined {
  if (!el) return undefined
  const val = wa(el, 'val')
  if (val === 'solid') return hexColor(wa(el, 'color')) ?? '#000000'
  if (val === 'nil') return null
  return hexColor(wa(el, 'fill'))
}

function edgeBorders(el: Element | null): EdgeBorders | undefined {
  if (!el) return undefined
  const out: EdgeBorders = {}
  const set = (key: keyof EdgeBorders, ...names: string[]) => {
    for (const n of names) {
      const b = parseBorder(wc(el, n))
      if (b) {
        out[key] = b
        return
      }
    }
  }
  set('top', 'top')
  set('bottom', 'bottom')
  set('start', 'start', 'left')
  set('end', 'end', 'right')
  set('insideH', 'insideH')
  set('insideV', 'insideV')
  return out
}

function margins(el: Element | null): Margins | undefined {
  if (!el) return undefined
  const w = (names: string[]) => {
    for (const n of names) {
      const e = wc(el, n)
      if (e && (wa(e, 'type') ?? 'dxa') === 'dxa') {
        const v = twipsPt(wa(e, 'w'))
        if (v !== null) return v
      }
    }
    return undefined
  }
  const out: Margins = {}
  const t = w(['top'])
  const b = w(['bottom'])
  const s = w(['start', 'left'])
  const e = w(['end', 'right'])
  if (t !== undefined) out.topPt = t
  if (b !== undefined) out.bottomPt = b
  if (s !== undefined) out.startPt = s
  if (e !== undefined) out.endPt = e
  return out
}

function tableWidth(el: Element | null): TableWidth | undefined {
  if (!el) return undefined
  const type = wa(el, 'type') ?? 'dxa'
  const raw = wa(el, 'w')
  if (type === 'auto' || type === 'nil') return { type: 'auto' }
  if (type === 'pct') {
    if (raw?.endsWith('%')) return { type: 'pct', value: Number(raw.slice(0, -1)) }
    const n = intOr(raw)
    // ST_DecimalNumberOrPercent: fiftieths of a percent.
    return n === null ? undefined : { type: 'pct', value: n / 50 }
  }
  const v = twipsPt(raw)
  return v === null ? undefined : { type: 'pt', value: v }
}

// ---------------------------------------------------------------- runs

const TOGGLES = ['bold', 'boldCs', 'italic', 'italicCs', 'caps', 'smallCaps', 'strike', 'doubleStrike', 'vanish'] as const
export type ToggleProp = (typeof TOGGLES)[number]
export const TOGGLE_PROPS: readonly ToggleProp[] = TOGGLES

const THEME_SLOT: Record<string, ['major' | 'minor', 'latin' | 'ea' | 'cs']> = {
  majorAscii: ['major', 'latin'],
  majorHAnsi: ['major', 'latin'],
  majorEastAsia: ['major', 'ea'],
  majorBidi: ['major', 'cs'],
  minorAscii: ['minor', 'latin'],
  minorHAnsi: ['minor', 'latin'],
  minorEastAsia: ['minor', 'ea'],
  minorBidi: ['minor', 'cs'],
}

function parseFonts(el: Element | null, theme: ThemeFonts): Fonts | undefined {
  if (!el) return undefined
  const out: Fonts = {}
  for (const k of ['ascii', 'hAnsi', 'eastAsia', 'cs'] as const) {
    // A theme font attribute supersedes the plain one (§17.3.2.26).
    const themeRef = wa(el, `${k === 'cs' ? 'cs' : k}Theme`)
    const slot = themeRef ? THEME_SLOT[themeRef] : undefined
    const fromTheme = slot ? theme[slot[0]][slot[1]] : undefined
    const name = fromTheme || wa(el, k)
    if (name) out[k] = name
  }
  return out
}

export function parseRunProps(rPr: Element | null, theme: ThemeFonts): RunProps {
  const out: RunProps = {}
  if (!rPr) return out
  const flag = (key: ToggleProp, local: string) => {
    const v = onOff(wc(rPr, local))
    if (v !== undefined) out[key] = v
  }
  flag('bold', 'b')
  flag('boldCs', 'bCs')
  flag('italic', 'i')
  flag('italicCs', 'iCs')
  flag('caps', 'caps')
  flag('smallCaps', 'smallCaps')
  flag('strike', 'strike')
  flag('doubleStrike', 'dstrike')
  flag('vanish', 'vanish')
  const u = wc(rPr, 'u')
  if (u) {
    out.underline = wa(u, 'val') ?? 'single'
    const c = wa(u, 'color')
    if (c) out.underlineColor = hexColor(c)
  }
  const sz = halfPointsPt(wa(wc(rPr, 'sz'), 'val'))
  if (sz !== null) out.sizePt = sz
  const szCs = halfPointsPt(wa(wc(rPr, 'szCs'), 'val'))
  if (szCs !== null) out.sizeCsPt = szCs
  const color = wc(rPr, 'color')
  if (color) out.color = hexColor(wa(color, 'val'))
  const hl = wa(wc(rPr, 'highlight'), 'val')
  if (hl) out.highlight = hl
  const shd = parseShading(wc(rPr, 'shd'))
  if (shd !== undefined) out.shading = shd
  const fonts = parseFonts(wc(rPr, 'rFonts'), theme)
  if (fonts) out.fonts = fonts
  const va = wa(wc(rPr, 'vertAlign'), 'val')
  if (va === 'superscript' || va === 'subscript' || va === 'baseline') out.vertAlign = va
  const rtl = onOff(wc(rPr, 'rtl'))
  if (rtl !== undefined) out.rtl = rtl
  const cs = onOff(wc(rPr, 'cs'))
  if (cs !== undefined) out.cs = cs
  const spacing = twipsPt(wa(wc(rPr, 'spacing'), 'val'))
  if (spacing !== null) out.spacingPt = spacing
  const pos = halfPointsPt(wa(wc(rPr, 'position'), 'val'))
  if (pos !== null) out.positionPt = pos
  const scale = intOr(wa(wc(rPr, 'w'), 'val'))
  if (scale !== null) out.scalePct = scale
  const lang = wc(rPr, 'lang')
  if (lang) {
    const l: NonNullable<RunProps['lang']> = {}
    const val = wa(lang, 'val')
    const ea = wa(lang, 'eastAsia')
    const bidi = wa(lang, 'bidi')
    if (val) l.val = val
    if (ea) l.eastAsia = ea
    if (bidi) l.bidi = bidi
    out.lang = l
  }
  const bdr = parseBorder(wc(rPr, 'bdr'))
  if (bdr) out.border = bdr
  return out
}

/** Later wins, field by field (fonts and lang per attribute). */
export function mergeRun(base: RunProps, over: RunProps): RunProps {
  const out: RunProps = { ...base, ...over }
  if (base.fonts || over.fonts) out.fonts = { ...base.fonts, ...over.fonts }
  if (base.lang || over.lang) out.lang = { ...base.lang, ...over.lang }
  return out
}

/**
 * A style layer over what came before in the style hierarchy (§17.7.3):
 * toggle properties (bold, italic, caps, …) set to true flip the current
 * state and false leaves it; everything else replaces.
 */
export function applyRunStyleLayer(acc: RunProps, layer: RunProps): RunProps {
  const plain: RunProps = { ...layer }
  for (const t of TOGGLES) delete plain[t]
  const out = mergeRun(acc, plain)
  for (const t of TOGGLES) {
    if (layer[t] === true) out[t] = !acc[t]
  }
  return out
}

// ---------------------------------------------------------------- paragraphs

const TAB_ALIGN: Record<string, TabStop['align']> = {
  left: 'start',
  start: 'start',
  right: 'end',
  end: 'end',
  center: 'center',
  decimal: 'decimal',
  bar: 'bar',
  num: 'num',
  clear: 'clear',
}
const LEADERS = new Set(['none', 'dot', 'hyphen', 'underscore', 'heavy', 'middleDot'])

/** ST_Jc (§17.18.44) as a logical alignment: left/start → start, right/end → end, both and the kashida/Thai variants → justify. */
export function alignOfJc(jc: string): NonNullable<ParagraphProps['align']> {
  if (jc === 'center') return 'center'
  if (jc === 'right' || jc === 'end') return 'end'
  if (jc === 'both' || jc === 'lowKashida' || jc === 'mediumKashida' || jc === 'highKashida' || jc === 'thaiDistribute') return 'justify'
  if (jc === 'distribute') return 'distribute'
  return 'start'
}

export function parseParagraphProps(pPr: Element | null, theme: ThemeFonts): ParagraphProps {
  const out: ParagraphProps = {}
  if (!pPr) return out
  const style = wa(wc(pPr, 'pStyle'), 'val')
  if (style) out.styleId = style
  const jc = wa(wc(pPr, 'jc'), 'val')
  if (jc) out.align = alignOfJc(jc)
  const ind = wc(pPr, 'ind')
  if (ind) {
    const i: NonNullable<ParagraphProps['indent']> = {}
    const start = twipsPt(wa(ind, 'start') ?? wa(ind, 'left'))
    const end = twipsPt(wa(ind, 'end') ?? wa(ind, 'right'))
    const hanging = twipsPt(wa(ind, 'hanging'))
    const first = twipsPt(wa(ind, 'firstLine'))
    if (start !== null) i.startPt = start
    if (end !== null) i.endPt = end
    if (hanging !== null) i.firstLinePt = -hanging
    else if (first !== null) i.firstLinePt = first
    out.indent = i
  }
  const sp = wc(pPr, 'spacing')
  if (sp) {
    const s: NonNullable<ParagraphProps['spacing']> = {}
    const before = twipsPt(wa(sp, 'before'))
    const after = twipsPt(wa(sp, 'after'))
    if (before !== null) s.beforePt = before
    if (after !== null) s.afterPt = after
    const ba = attrOnOff(wa(sp, 'beforeAutospacing'))
    const aa = attrOnOff(wa(sp, 'afterAutospacing'))
    if (ba !== undefined) s.beforeAuto = ba
    if (aa !== undefined) s.afterAuto = aa
    const line = intOr(wa(sp, 'line'))
    if (line !== null) {
      const rule = wa(sp, 'lineRule') ?? 'auto'
      s.line = rule === 'exact' || rule === 'atLeast' ? { rule, pt: line / 20 } : { rule: 'auto', multiple: line / 240 }
    }
    out.spacing = s
  }
  const flag = (key: 'contextualSpacing' | 'keepNext' | 'keepLines' | 'pageBreakBefore' | 'widowControl' | 'bidi', local: string) => {
    const v = onOff(wc(pPr, local))
    if (v !== undefined) out[key] = v
  }
  flag('contextualSpacing', 'contextualSpacing')
  flag('keepNext', 'keepNext')
  flag('keepLines', 'keepLines')
  flag('pageBreakBefore', 'pageBreakBefore')
  flag('widowControl', 'widowControl')
  flag('bidi', 'bidi')
  const tabs = wc(pPr, 'tabs')
  if (tabs) {
    out.tabs = wcs(tabs, 'tab').flatMap((t) => {
      const pos = twipsPt(wa(t, 'pos'))
      const align = TAB_ALIGN[wa(t, 'val') ?? 'left']
      if (pos === null || !align) return []
      const leader = wa(t, 'leader') ?? 'none'
      return [{ align, posPt: pos, leader: (LEADERS.has(leader) ? leader : 'none') as TabStop['leader'] }]
    })
  }
  const lvl = intOr(wa(wc(pPr, 'outlineLvl'), 'val'))
  if (lvl !== null) out.outlineLevel = lvl
  const numPr = wc(pPr, 'numPr')
  if (numPr) {
    const numId = wa(wc(numPr, 'numId'), 'val')
    const ilvl = intOr(wa(wc(numPr, 'ilvl'), 'val'))
    if (numId !== null) out.numbering = ilvl === null ? { numId } : { numId, ilvl }
    else if (ilvl !== null) out.numbering = { numId: '', ilvl }
  }
  const shd = parseShading(wc(pPr, 'shd'))
  if (shd !== undefined) out.shading = shd
  const pBdr = wc(pPr, 'pBdr')
  if (pBdr) {
    const b: ParagraphBorders = {}
    const top = parseBorder(wc(pBdr, 'top'))
    const bottom = parseBorder(wc(pBdr, 'bottom'))
    const start = parseBorder(wc(pBdr, 'start') ?? wc(pBdr, 'left'))
    const end = parseBorder(wc(pBdr, 'end') ?? wc(pBdr, 'right'))
    const between = parseBorder(wc(pBdr, 'between'))
    if (top) b.top = top
    if (bottom) b.bottom = bottom
    if (start) b.start = start
    if (end) b.end = end
    if (between) b.between = between
    out.borders = b
  }
  const rPr = wc(pPr, 'rPr')
  if (rPr) out.markRun = parseRunProps(rPr, theme)
  return out
}

/** An ST_OnOff attribute (e.g. w:beforeAutospacing="1"). */
const attrOnOff = (v: string | null): boolean | undefined => (v === null ? undefined : !(v === 'false' || v === '0' || v === 'off'))

/** Tab stops merge by position; a "clear" stop removes an inherited one at that position (§17.3.1.37). */
export function mergeTabs(base: TabStop[] | undefined, over: TabStop[] | undefined): TabStop[] | undefined {
  if (!over) return base
  const byPos = new Map<number, TabStop>()
  for (const t of base ?? []) byPos.set(Math.round(t.posPt * 20), t)
  for (const t of over) {
    const k = Math.round(t.posPt * 20)
    if (t.align === 'clear') byPos.delete(k)
    else byPos.set(k, t)
  }
  return [...byPos.values()].sort((a, b) => a.posPt - b.posPt)
}

export function mergeParagraph(base: ParagraphProps, over: ParagraphProps): ParagraphProps {
  const out: ParagraphProps = { ...base, ...over }
  if (base.indent || over.indent) out.indent = { ...base.indent, ...over.indent }
  if (base.spacing || over.spacing) out.spacing = { ...base.spacing, ...over.spacing }
  if (base.borders || over.borders) out.borders = { ...base.borders, ...over.borders }
  if (base.markRun || over.markRun) out.markRun = mergeRun(base.markRun ?? {}, over.markRun ?? {})
  const tabs = mergeTabs(base.tabs, over.tabs)
  if (tabs) out.tabs = tabs
  else delete out.tabs
  if (over.numbering && base.numbering) {
    out.numbering = { ...base.numbering, ...over.numbering }
    if (over.numbering.numId === '') out.numbering.numId = base.numbering.numId
  }
  return out
}

// ---------------------------------------------------------------- tables

function parseLook(el: Element | null): TableLook | undefined {
  if (!el) return undefined
  const hex = wa(el, 'val')
  const bits = hex && /^[0-9a-fA-F]{4}$/.test(hex) ? Number.parseInt(hex, 16) : null
  const flag = (local: string, bit: number) => {
    const v = wa(el, local)
    if (v !== null) return v === '1' || v === 'true' || v === 'on'
    return bits !== null ? (bits & bit) !== 0 : false
  }
  // Bit values: §17.4.56 (transitional tblLook w:val bitmask).
  return {
    firstRow: flag('firstRow', 0x0020),
    lastRow: flag('lastRow', 0x0040),
    firstColumn: flag('firstColumn', 0x0080),
    lastColumn: flag('lastColumn', 0x0100),
    noHBand: flag('noHBand', 0x0200),
    noVBand: flag('noVBand', 0x0400),
  }
}

export function parseTableProps(tblPr: Element | null): TableProps {
  const out: TableProps = {}
  if (!tblPr) return out
  const style = wa(wc(tblPr, 'tblStyle'), 'val')
  if (style) out.styleId = style
  const w = tableWidth(wc(tblPr, 'tblW'))
  if (w) out.width = w
  const jc = wa(wc(tblPr, 'jc'), 'val')
  if (jc) out.align = jc === 'center' ? 'center' : jc === 'right' || jc === 'end' ? 'end' : 'start'
  const ind = wc(tblPr, 'tblInd')
  if (ind && (wa(ind, 'type') ?? 'dxa') === 'dxa') {
    const v = twipsPt(wa(ind, 'w'))
    if (v !== null) out.indentPt = v
  }
  const borders = edgeBorders(wc(tblPr, 'tblBorders'))
  if (borders) out.borders = borders
  const mar = margins(wc(tblPr, 'tblCellMar'))
  if (mar) out.cellMargins = mar
  const layout = wa(wc(tblPr, 'tblLayout'), 'type')
  if (layout === 'fixed' || layout === 'autofit') out.layout = layout
  const shd = parseShading(wc(tblPr, 'shd'))
  if (shd !== undefined) out.shading = shd
  const bidi = onOff(wc(tblPr, 'bidiVisual'))
  if (bidi !== undefined) out.bidiVisual = bidi
  const look = parseLook(wc(tblPr, 'tblLook'))
  if (look) out.look = look
  const rb = intOr(wa(wc(tblPr, 'tblStyleRowBandSize'), 'val'))
  if (rb !== null) out.rowBandSize = rb
  const cb = intOr(wa(wc(tblPr, 'tblStyleColBandSize'), 'val'))
  if (cb !== null) out.colBandSize = cb
  const spacing = wc(tblPr, 'tblCellSpacing')
  if (spacing && (wa(spacing, 'type') ?? 'dxa') === 'dxa') {
    const v = twipsPt(wa(spacing, 'w'))
    if (v !== null) out.cellSpacingPt = v
  }
  return out
}

export function mergeTable(base: TableProps, over: TableProps): TableProps {
  const out: TableProps = { ...base, ...over }
  if (base.borders || over.borders) out.borders = { ...base.borders, ...over.borders }
  if (base.cellMargins || over.cellMargins) out.cellMargins = { ...base.cellMargins, ...over.cellMargins }
  return out
}

export function parseRowProps(trPr: Element | null, tr: Element): RowProps {
  const out: RowProps = {}
  if (trPr) {
    const h = wc(trPr, 'trHeight')
    if (h) {
      const v = twipsPt(wa(h, 'val'))
      if (v !== null) out.heightPt = v
      const rule = wa(h, 'hRule')
      out.heightRule = rule === 'exact' ? 'exact' : rule === 'auto' ? 'auto' : 'atLeast'
    }
    const header = onOff(wc(trPr, 'tblHeader'))
    if (header !== undefined) out.header = header
    const cant = onOff(wc(trPr, 'cantSplit'))
    if (cant !== undefined) out.cantSplit = cant
    const gb = intOr(wa(wc(trPr, 'gridBefore'), 'val'))
    if (gb !== null) out.gridBefore = gb
    const ga = intOr(wa(wc(trPr, 'gridAfter'), 'val'))
    if (ga !== null) out.gridAfter = ga
  }
  void tr
  return out
}

export function parseCellProps(tcPr: Element | null): CellProps {
  const out: CellProps = {}
  if (!tcPr) return out
  const w = tableWidth(wc(tcPr, 'tcW'))
  if (w) out.width = w
  const span = intOr(wa(wc(tcPr, 'gridSpan'), 'val'))
  if (span !== null && span > 1) out.span = span
  const vm = wc(tcPr, 'vMerge')
  if (vm) out.vMerge = wa(vm, 'val') === 'restart' ? 'restart' : 'continue'
  const borders = edgeBorders(wc(tcPr, 'tcBorders'))
  if (borders) out.borders = borders
  const shd = parseShading(wc(tcPr, 'shd'))
  if (shd !== undefined) out.shading = shd
  const mar = margins(wc(tcPr, 'tcMar'))
  if (mar) out.margins = mar
  const va = wa(wc(tcPr, 'vAlign'), 'val')
  if (va === 'top' || va === 'center' || va === 'bottom') out.vAlign = va
  const td = wa(wc(tcPr, 'textDirection'), 'val')
  if (td) out.textDirection = td
  const nw = onOff(wc(tcPr, 'noWrap'))
  if (nw !== undefined) out.noWrap = nw
  return out
}

export function mergeCell(base: CellProps, over: CellProps): CellProps {
  const out: CellProps = { ...base, ...over }
  if (base.borders || over.borders) out.borders = { ...base.borders, ...over.borders }
  if (base.margins || over.margins) out.margins = { ...base.margins, ...over.margins }
  return out
}

// ---------------------------------------------------------------- sections

export type HeaderFooterRefs = { default?: string; first?: string; even?: string }

export type SectionProps = {
  pageWidthPt: number
  pageHeightPt: number
  orientation: 'portrait' | 'landscape'
  margin: { topPt: number; rightPt: number; bottomPt: number; leftPt: number; headerPt: number; footerPt: number; gutterPt: number }
  columns: { count: number; spacePt: number }
  /** How the section starts (w:type): a new page unless continuous. */
  start: 'nextPage' | 'continuous' | 'evenPage' | 'oddPage' | 'nextColumn'
  titlePage: boolean
  /** Header/footer part names by type, as this section declares them (inheritance: model.ts). */
  headers: HeaderFooterRefs
  footers: HeaderFooterRefs
  pageNumbers: { start?: number; format?: string }
  bidi: boolean
}

/** Word's defaults for a sectPr that leaves things out: US Letter, 1"/1.25" margins. */
const DEFAULT_SECTION: Omit<SectionProps, 'headers' | 'footers' | 'pageNumbers'> = {
  pageWidthPt: 612,
  pageHeightPt: 792,
  orientation: 'portrait',
  margin: { topPt: 72, rightPt: 90, bottomPt: 72, leftPt: 90, headerPt: 36, footerPt: 36, gutterPt: 0 },
  columns: { count: 1, spacePt: 36 },
  start: 'nextPage',
  titlePage: false,
  bidi: false,
}

export function parseSectionProps(sectPr: Element | null, resolveRel: (id: string) => string | null): SectionProps {
  const out: SectionProps = {
    ...DEFAULT_SECTION,
    margin: { ...DEFAULT_SECTION.margin },
    columns: { ...DEFAULT_SECTION.columns },
    headers: {},
    footers: {},
    pageNumbers: {},
  }
  if (!sectPr) return out
  const sz = wc(sectPr, 'pgSz')
  if (sz) {
    out.pageWidthPt = twipsPt(wa(sz, 'w')) ?? out.pageWidthPt
    out.pageHeightPt = twipsPt(wa(sz, 'h')) ?? out.pageHeightPt
    out.orientation = wa(sz, 'orient') === 'landscape' ? 'landscape' : 'portrait'
  }
  const mar = wc(sectPr, 'pgMar')
  if (mar) {
    const m = out.margin
    m.topPt = twipsPt(wa(mar, 'top')) ?? m.topPt
    m.rightPt = twipsPt(wa(mar, 'right')) ?? m.rightPt
    m.bottomPt = twipsPt(wa(mar, 'bottom')) ?? m.bottomPt
    m.leftPt = twipsPt(wa(mar, 'left')) ?? m.leftPt
    m.headerPt = twipsPt(wa(mar, 'header')) ?? m.headerPt
    m.footerPt = twipsPt(wa(mar, 'footer')) ?? m.footerPt
    m.gutterPt = twipsPt(wa(mar, 'gutter')) ?? m.gutterPt
  }
  const cols = wc(sectPr, 'cols')
  if (cols) {
    const listed = wcs(cols, 'col').length
    out.columns = {
      count: intOr(wa(cols, 'num')) ?? (listed > 0 ? listed : 1),
      spacePt: twipsPt(wa(cols, 'space')) ?? 36,
    }
  }
  const type = wa(wc(sectPr, 'type'), 'val')
  if (type === 'continuous' || type === 'evenPage' || type === 'oddPage' || type === 'nextColumn') out.start = type
  out.titlePage = onOff(wc(sectPr, 'titlePg')) ?? false
  out.bidi = onOff(wc(sectPr, 'bidi')) ?? false
  for (const [local, target] of [
    ['headerReference', out.headers],
    ['footerReference', out.footers],
  ] as const) {
    for (const ref of wcs(sectPr, local)) {
      const kind = wa(ref, 'type') ?? 'default'
      const id = attr(ref, NS.r, 'id')
      const part = id ? resolveRel(id) : null
      if (part && (kind === 'default' || kind === 'first' || kind === 'even')) target[kind] = part
    }
  }
  const pn = wc(sectPr, 'pgNumType')
  if (pn) {
    const start = intOr(wa(pn, 'start'))
    if (start !== null) out.pageNumbers.start = start
    const fmt = wa(pn, 'fmt')
    if (fmt) out.pageNumbers.format = fmt
  }
  return out
}

// ---------------------------------------------------------------- drawing helpers

/** wp:extent / a:ext size in points. */
export function extentPt(el: Element | null): { widthPt: number; heightPt: number } | null {
  if (!el) return null
  const w = emuPt(attr(el, null, 'cx'))
  const h = emuPt(attr(el, null, 'cy'))
  return w === null || h === null ? null : { widthPt: w, heightPt: h }
}
