import {
  BORDER_STYLES,
  HORIZONTAL,
  VERTICAL,
  type BorderStyle,
  type Horizontal,
  type Vertical,
} from './style-choices'
import { ensureCellXfs, STYLESHEET_ORDER } from './styles'
import { XlsxError } from './workbook'
import { insertInOrder, kid, kids, make } from './xml'

/**
 * Font, fill, border and alignment edits in the styles part (ECMA-376 Part 1
 * §18.8). Like number formats (./styles.ts `xfWithNumFmt`), a cell's new look
 * is a copy of its format record (`xf`) with only what was edited changed —
 * its font, fill or border record copied the same way — and an identical
 * record already in the file is reused instead of adding another. Records
 * nothing points at any more stay (other cells, named styles and conditional
 * formats may still use them; Excel keeps them too).
 */

export type Side = 'left' | 'right' | 'top' | 'bottom'
/** One edge as written: a line (style, colour "#RRGGBB" or null for automatic) or none. */
export type EdgeWrite = { style: BorderStyle; color: string | null } | null

export type FontPatch = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
  strike?: boolean
  sizePt?: number
  /** "#RRGGBB", or null: the automatic (default) colour. */
  color?: string | null
  name?: string
}

export type XfPatch = {
  font?: FontPatch
  /** A solid background "#RRGGBB", or null: no fill. */
  fill?: string | null
  border?: Partial<Record<Side, EdgeWrite>>
  /** null: Excel's default (general / bottom). */
  horizontal?: Horizontal | null
  vertical?: Vertical | null
  wrap?: boolean
}

const HEX = /^#[0-9A-Fa-f]{6}$/

/** "#rrggbb" → the ARGB Excel writes ("FFRRGGBB"); anything else is refused. */
export function argb(color: string): string {
  if (!HEX.test(color)) throw new XlsxError(`“${color}” is not a colour like #1F4E79.`)
  return `FF${color.slice(1).toUpperCase()}`
}

/** CT_Font's children in the order Excel writes them (the schema allows any order). */
const FONT_ORDER = [
  'b',
  'i',
  'strike',
  'condense',
  'extend',
  'outline',
  'shadow',
  'u',
  'vertAlign',
  'sz',
  'color',
  'name',
  'family',
  'charset',
  'scheme',
] as const
/** CT_Border's children (§18.8.4). */
const BORDER_ORDER = [
  'start',
  'end',
  'left',
  'right',
  'top',
  'bottom',
  'diagonal',
  'vertical',
  'horizontal',
] as const
/** CT_Xf's children (§18.8.45). */
const XF_ORDER = ['alignment', 'protection', 'extLst'] as const

/**
 * A record's full content (attributes sorted, children in order, all the way
 * down): equal means the same look. A cell format's apply* flags are left
 * out — they only say the record's own values are used, and two records with
 * the same values look the same either way.
 */
export function deepSignature(el: Element): string {
  const attrs: string[] = []
  for (let i = 0; i < el.attributes.length; i++) {
    const a = el.attributes[i]!
    if (el.localName === 'xf' && a.name.startsWith('apply')) continue
    attrs.push(`${a.name}=${a.value}`)
  }
  attrs.sort()
  const children: string[] = []
  for (let n = el.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1) children.push(deepSignature(n as Element))
    else if (n.nodeType === 3 && (n.nodeValue ?? '').trim() !== '') children.push(n.nodeValue!)
  }
  return `${el.localName}(${attrs.join(' ')})[${children.join(',')}]`
}

/** The list element `name` of the styles part (made, in schema order, when missing). */
function listOf(doc: XMLDocument, name: 'fonts' | 'fills' | 'borders', first: () => Element) {
  const root = doc.documentElement!
  let el = kid(root, name)
  if (!el) {
    el = make(doc, name)
    el.appendChild(first())
    el.setAttribute('count', '1')
    insertInOrder(root, el, STYLESHEET_ORDER)
  }
  return el
}

/**
 * The index of `copy` in `list`: `baseIndex` when it equals the record it was
 * copied from, an identical existing record, else `copy` appended.
 */
function placeRecord(list: Element, copy: Element, baseIndex: number, local: string): number {
  const items = kids(list, local)
  const key = deepSignature(copy)
  if (items[baseIndex] && deepSignature(items[baseIndex]) === key) return baseIndex
  const same = items.findIndex((x) => deepSignature(x) === key)
  if (same >= 0) return same
  list.appendChild(copy)
  list.setAttribute('count', String(items.length + 1))
  return items.length
}

function child(doc: XMLDocument, parent: Element, local: string, order: readonly string[]) {
  const hit = kid(parent, local)
  if (hit) return hit
  const el = make(doc, local)
  insertInOrder(parent, el, order)
  return el
}

function drop(parent: Element, local: string) {
  for (const k of kids(parent, local)) parent.removeChild(k)
}

const flagOn = (el: Element | null) => {
  if (!el) return false
  const v = el.getAttribute('val')
  return v === null || v === '1' || v === 'true'
}

function setFlag(doc: XMLDocument, font: Element, local: 'b' | 'i' | 'strike', on: boolean) {
  if (flagOn(kid(font, local)) === on) return
  drop(font, local)
  if (on) child(doc, font, local, FONT_ORDER)
}

function fontWith(doc: XMLDocument, fontId: number, patch: FontPatch): number {
  const list = listOf(doc, 'fonts', () => {
    const f = make(doc, 'font')
    const sz = make(doc, 'sz')
    sz.setAttribute('val', '11')
    f.appendChild(sz)
    return f
  })
  const fonts = kids(list, 'font')
  const baseIndex = fonts[fontId] ? fontId : 0
  const copy = fonts[baseIndex]!.cloneNode(true) as Element
  if (patch.bold !== undefined) setFlag(doc, copy, 'b', patch.bold)
  if (patch.italic !== undefined) setFlag(doc, copy, 'i', patch.italic)
  if (patch.strike !== undefined) setFlag(doc, copy, 'strike', patch.strike)
  if (patch.underline !== undefined) {
    const u = kid(copy, 'u')
    const on = !!u && u.getAttribute('val') !== 'none'
    if (on !== patch.underline) {
      drop(copy, 'u')
      // A single underline (the default value of <u/>), as Ctrl+U makes it.
      if (patch.underline) child(doc, copy, 'u', FONT_ORDER)
    }
  }
  if (patch.sizePt !== undefined) {
    if (!(patch.sizePt >= 1 && patch.sizePt <= 409))
      throw new XlsxError(`${patch.sizePt} pt is not a font size (1 to 409).`)
    child(doc, copy, 'sz', FONT_ORDER).setAttribute('val', String(patch.sizePt))
  }
  if (patch.color !== undefined) {
    drop(copy, 'color')
    if (patch.color !== null)
      child(doc, copy, 'color', FONT_ORDER).setAttribute('rgb', argb(patch.color))
  }
  if (patch.name !== undefined) {
    const name = patch.name.trim()
    if (name === '' || name.length > 31)
      throw new XlsxError(`“${patch.name}” is not a font name (1 to 31 characters).`)
    child(doc, copy, 'name', FONT_ORDER).setAttribute('val', name)
    // A theme font (scheme) wins over the name in Excel: the chosen font is no longer the theme's.
    drop(copy, 'scheme')
  }
  return placeRecord(list, copy, baseIndex, 'font')
}

function fillWith(doc: XMLDocument, color: string | null): number {
  const list = listOf(doc, 'fills', () => {
    const f = make(doc, 'fill')
    const p = make(doc, 'patternFill')
    p.setAttribute('patternType', 'none')
    f.appendChild(p)
    return f
  })
  // Fill 0 is "none" in every workbook (Excel requires it there).
  if (color === null) return 0
  const fill = make(doc, 'fill')
  const p = make(doc, 'patternFill')
  p.setAttribute('patternType', 'solid')
  const fg = make(doc, 'fgColor')
  fg.setAttribute('rgb', argb(color))
  const bg = make(doc, 'bgColor')
  bg.setAttribute('indexed', '64')
  p.appendChild(fg)
  p.appendChild(bg)
  fill.appendChild(p)
  return placeRecord(list, fill, -1, 'fill')
}

function borderWith(
  doc: XMLDocument,
  borderId: number,
  edges: Partial<Record<Side, EdgeWrite>>,
): number {
  const list = listOf(doc, 'borders', () => {
    const b = make(doc, 'border')
    for (const n of ['left', 'right', 'top', 'bottom', 'diagonal']) b.appendChild(make(doc, n))
    return b
  })
  const borders = kids(list, 'border')
  const baseIndex = borders[borderId] ? borderId : 0
  const copy = borders[baseIndex]!.cloneNode(true) as Element
  for (const [side, edge] of Object.entries(edges) as Array<[Side, EdgeWrite]>) {
    if (edge !== null && !(BORDER_STYLES as readonly string[]).includes(edge.style))
      throw new XlsxError(`“${edge.style}” is not a border style (${BORDER_STYLES.join(', ')}).`)
    // The writing-direction names (start/end) mean left/right here: one element per edge.
    if (side === 'left') drop(copy, 'start')
    if (side === 'right') drop(copy, 'end')
    const el = make(doc, side)
    if (edge) {
      el.setAttribute('style', edge.style)
      const c = make(doc, 'color')
      if (edge.color === null) c.setAttribute('indexed', '64')
      else c.setAttribute('rgb', argb(edge.color))
      el.appendChild(c)
    }
    const old = kid(copy, side)
    if (old) copy.replaceChild(el, old)
    else insertInOrder(copy, el, BORDER_ORDER)
  }
  return placeRecord(list, copy, baseIndex, 'border')
}

/**
 * The cellXfs index of format `xfIndex` with `patch` applied: a copy of that
 * record (number format, protection, named style and every untouched part
 * kept), or an identical existing record. Edits `doc`, the styles part.
 */
export function xfWithPatch(doc: XMLDocument, xfIndex: number, patch: XfPatch): number {
  const xfsEl = ensureCellXfs(doc)
  const xfs = kids(xfsEl, 'xf')
  const baseIndex = xfs[xfIndex] ? xfIndex : 0
  const base = xfs[baseIndex]!
  const copy = base.cloneNode(true) as Element
  const swap = (attr: string, apply: string, next: number) => {
    if (Number(copy.getAttribute(attr) ?? 0) === next) return
    copy.setAttribute(attr, String(next))
    copy.setAttribute(apply, '1')
  }
  if (patch.font && Object.keys(patch.font).length > 0)
    swap('fontId', 'applyFont', fontWith(doc, Number(base.getAttribute('fontId') ?? 0), patch.font))
  if (patch.fill !== undefined) swap('fillId', 'applyFill', fillWith(doc, patch.fill))
  if (patch.border && Object.keys(patch.border).length > 0)
    swap(
      'borderId',
      'applyBorder',
      borderWith(doc, Number(base.getAttribute('borderId') ?? 0), patch.border),
    )
  if (patch.horizontal !== undefined || patch.vertical !== undefined || patch.wrap !== undefined) {
    const align = child(doc, copy, 'alignment', XF_ORDER)
    const set = (attr: string, value: string | null) => {
      if (value === null) align.removeAttribute(attr)
      else align.setAttribute(attr, value)
    }
    if (patch.horizontal !== undefined) {
      if (patch.horizontal !== null && !HORIZONTAL.includes(patch.horizontal))
        throw new XlsxError(`“${patch.horizontal}” is not a horizontal alignment.`)
      set('horizontal', patch.horizontal === 'general' ? null : patch.horizontal)
    }
    if (patch.vertical !== undefined) {
      if (patch.vertical !== null && !VERTICAL.includes(patch.vertical))
        throw new XlsxError(`“${patch.vertical}” is not a vertical alignment.`)
      set('vertical', patch.vertical === 'bottom' ? null : patch.vertical)
    }
    if (patch.wrap !== undefined) set('wrapText', patch.wrap ? '1' : null)
    if (align.attributes.length === 0 && kids(align, undefined).length === 0)
      copy.removeChild(align)
    const was = kid(base, 'alignment')
    const now = kid(copy, 'alignment')
    if ((was ? deepSignature(was) : '') !== (now ? deepSignature(now) : ''))
      copy.setAttribute('applyAlignment', '1')
  }
  return placeRecord(xfsEl, copy, baseIndex, 'xf')
}
