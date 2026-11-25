import type { Calc } from './calc'
import { tokenize } from '@borgar/fx/xlsx'
import { relsPartOf } from '../ooxml/package'
import { finishSheet, sheetDoc, stylesDoc } from './ops'
import { restyleRange } from './protection'
import {
  cellKey,
  cellName,
  parseCell,
  parseRange,
  rangeName,
  requireRange,
  type Range,
} from './ref'
import { WORKSHEET_ORDER } from './sheet-order'
import { writeCell } from './sheet-xml'
import { overlaps } from './sqref'
import { xfWithPatch } from './style-records'
import { isErrorValue, XlsxError, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make, NS_R, REL } from './xml'

/**
 * Hyperlinks (ECMA-376 Part 1 §18.3.1.47): a cell's link to a web address
 * or e-mail (a relationship with TargetMode="External", the `r:id` on the
 * hyperlink) or to a place in the workbook (`location`, like Sheet2!A1 or a
 * defined name), plus its tooltip; and the HYPERLINK() worksheet function,
 * whose target is its first argument, calculated. Adding a link writes the
 * text to show into an empty cell and gives it Excel's link look (theme
 * hyperlink colour, underlined); removing keeps the cell's text and look
 * (Excel's Clear Hyperlinks).
 *
 * Opening follows only http, https, mailto and ftp addresses — anything
 * else (javascript:, file:, data:) is refused — and in-workbook places.
 */

export const REL_HYPERLINK = `${REL}hyperlink`

export type LinkTarget = { kind: 'url'; url: string } | { kind: 'place'; location: string }

export type HyperlinkView = {
  /** The cell or range the link is on ("B3", "A1:C1"). */
  ref: string
  range: Range
  target: LinkTarget
  tooltip: string | null
  display: string | null
}

export type HyperlinkOp =
  | {
      op: 'hyperlink_set'
      sheet: string
      /** The cell (or range) that links. */
      range: string
      /** A web or mail address ("https://…", "mailto:…"), or a place ("Sheet2!A1", "#Sheet2!A1", a defined name). */
      target: string
      tooltip?: string | null
      /** Text to show: written into the anchor cell when given (an empty cell gets the address). */
      text?: string | null
    }
  | { op: 'hyperlink_remove'; sheet: string; range: string }

const SAFE_SCHEMES = /^(https?|mailto|ftp):/i

/** A typed target → a URL or an in-workbook place (a scheme means a URL; a bare host gets https://). */
export function parseTarget(text: string): LinkTarget {
  const t = text.trim()
  if (t === '') throw new XlsxError('A link needs an address or a place in the workbook.')
  if (t.startsWith('#')) return { kind: 'place', location: t.slice(1) }
  if (/^[a-z][a-z0-9+.-]*:/i.test(t)) {
    if (!SAFE_SCHEMES.test(t))
      throw new XlsxError(
        `“${t}”: only web (http, https), mail (mailto) and ftp links can be added.`,
      )
    return { kind: 'url', url: t }
  }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { kind: 'url', url: `mailto:${t}` }
  if (/^www\./i.test(t)) return { kind: 'url', url: `https://${t}` }
  return { kind: 'place', location: t }
}

/** Whether a URL may be opened from the grid (web, mail, ftp only). */
export const openableUrl = (url: string) => SAFE_SCHEMES.test(url.trim())

export function hyperlinksOf(wb: Workbook, sheet: string): HyperlinkView[] {
  const info = wb.requireWorksheet(sheet)
  const root = wb.pkg.xml(info.part).documentElement!
  const list = kid(root, 'hyperlinks')
  const rels = new Map(wb.pkg.relationships(info.part).map((r) => [r.id, r]))
  return (list ? kids(list, 'hyperlink') : []).flatMap((h) => {
    const range = parseRange(h.getAttribute('ref') ?? '')
    if (!range) return []
    const rid = h.getAttributeNS(NS_R, 'id')
    const rel = rid ? rels.get(rid) : undefined
    const location = h.getAttribute('location')
    let target: LinkTarget
    if (rel) {
      const base = rel.target
      target = { kind: 'url', url: location ? `${base}#${location}` : base }
    } else if (location) target = { kind: 'place', location }
    else return []
    return [
      {
        ref: rangeName(range),
        range,
        target,
        tooltip: h.getAttribute('tooltip'),
        display: h.getAttribute('display'),
      },
    ]
  })
}

/** The link on a cell (a hyperlink element over it, else a HYPERLINK() formula's calculated target), or null. */
export function linkAt(
  wb: Workbook,
  calc: Calc,
  sheet: string,
  row: number,
  col: number,
  links: HyperlinkView[] = hyperlinksOf(wb, sheet),
): { target: LinkTarget; tooltip: string | null } | null {
  const hit = links.find(
    (l) =>
      row >= l.range.top && row <= l.range.bottom && col >= l.range.left && col <= l.range.right,
  )
  if (hit) return { target: hit.target, tooltip: hit.tooltip }
  const cell = wb.sheet(sheet).cells.get(cellKey(row, col))
  if (!cell?.formula) return null
  const first = hyperlinkArgument(cell.formula)
  if (first === null) return null
  const out = calc.evaluate(sheet, first, cellName({ row, col }))
  if (out.kept || isErrorValue(out.value) || out.value === null) return null
  const text = String(out.value)
  if (text === '') return null
  try {
    return { target: parseTarget(text), tooltip: null }
  } catch {
    // A HYPERLINK() to an address that can't be opened here (javascript: …) is shown, not followed.
    return null
  }
}

/**
 * The first argument of a formula that *is* a HYPERLINK() call (its outermost
 * function, nothing after it), as a formula of its own: CHOOSE(1, …) over the
 * same arguments yields exactly it. Decided from the formula's tokens.
 */
export function hyperlinkArgument(formula: string): string | null {
  const toks = (
    tokenize(formula, { mergeRefs: true }) as Array<{ type: string; value: string }>
  ).filter((t) => t.type !== 'whitespace')
  const name = toks[0]?.type === 'func' ? toks[0].value.replace(/^_xlfn\./i, '').toUpperCase() : ''
  if (name !== 'HYPERLINK' || toks[1]?.value !== '(' || toks.at(-1)?.value !== ')') return null
  let depth = 0
  for (let i = 1; i < toks.length; i++) {
    const v = toks[i]!.value
    if (v === '(' || v === '{') depth++
    else if (v === ')' || v === '}') depth--
    if (depth === 0 && i !== toks.length - 1) return null
  }
  const inner = formula.slice(formula.indexOf('(') + 1, formula.lastIndexOf(')'))
  return `CHOOSE(1,${inner})`
}

/** An in-workbook place → the sheet and cell range it points at (a defined name resolved), or null. */
export function resolvePlace(
  wb: Workbook,
  location: string,
  home: string,
  depth = 0,
): { sheet: string; range: Range } | null {
  if (depth > 8) return null
  const loc = location.trim().replace(/^#/, '')
  const bang = loc.lastIndexOf('!')
  if (bang > 0) {
    const sheetText = loc
      .slice(0, bang)
      .replace(/^'(.*)'$/, '$1')
      .replace(/''/g, "'")
    const info = wb.findSheet(sheetText)
    const range = parseRange(loc.slice(bang + 1).replace(/\$/g, ''))
    return info && range ? { sheet: info.name, range } : null
  }
  const range = parseRange(loc.replace(/\$/g, ''))
  if (range) return { sheet: home, range }
  const homeInfo = wb.findSheet(home)
  const name = wb
    .definedNames()
    .filter((n) => n.name.toLowerCase() === loc.toLowerCase())
    .sort((a, b) =>
      a.localSheet === homeInfo?.index ? -1 : b.localSheet === homeInfo?.index ? 1 : 0,
    )[0]
  if (!name) return null
  return resolvePlace(wb, name.formula, home, depth + 1)
}

// ---------------------------------------------------------------------------
// Writing

function removeRel(wb: Workbook, part: string, id: string) {
  const relsPart = relsPartOf(part)
  if (!wb.pkg.has(relsPart)) return
  const doc = wb.edit(relsPart)
  for (const r of kids(
    doc.documentElement!,
    'Relationship',
    'http://schemas.openxmlformats.org/package/2006/relationships',
  ))
    if (r.getAttribute('Id') === id) doc.documentElement!.removeChild(r)
}

/** The theme's hyperlink colour (accent "hlink"), Excel's link look. */
const LINK_COLOR = '#0563C1'

export function runHyperlinkOp(wb: Workbook, op: HyperlinkOp): string[] {
  const info = wb.requireWorksheet(op.sheet)
  const range = requireRange(op.range)
  if (op.op === 'hyperlink_remove') {
    const doc = sheetDoc(wb, info)
    const root = doc.documentElement!
    const list = kid(root, 'hyperlinks')
    let removed = 0
    for (const h of list ? kids(list, 'hyperlink') : []) {
      const r = parseRange(h.getAttribute('ref') ?? '')
      if (!r || !overlaps(r, range)) continue
      const rid = h.getAttributeNS(NS_R, 'id')
      list!.removeChild(h)
      if (rid && !kids(list!, 'hyperlink').some((x) => x.getAttributeNS(NS_R, 'id') === rid))
        removeRel(wb, info.part, rid)
      removed++
    }
    if (list && kids(list, 'hyperlink').length === 0) root.removeChild(list)
    if (removed === 0) return []
    finishSheet(wb, info, doc)
    return [info.name]
  }
  const target = parseTarget(op.target)
  if (target.kind === 'place' && !resolvePlace(wb, target.location, info.name))
    throw new XlsxError(`“${target.location}” is not a cell or a name in this workbook.`)
  if (op.tooltip && op.tooltip.length > 255)
    throw new XlsxError('A link’s tooltip can have at most 255 characters.')
  if (target.kind === 'url' && target.url.length > 2079)
    throw new XlsxError('Excel links can be at most 2079 characters long.')
  // The old links on these cells go first (one link per cell, as in Excel).
  runHyperlinkOp(wb, { op: 'hyperlink_remove', sheet: info.name, range: rangeName(range) })
  const doc = sheetDoc(wb, info)
  const root = doc.documentElement!
  let list = kid(root, 'hyperlinks')
  if (!list) {
    list = make(doc, 'hyperlinks')
    insertInOrder(root, list, WORKSHEET_ORDER)
  }
  const el = make(doc, 'hyperlink')
  el.setAttribute('ref', rangeName(range))
  if (target.kind === 'url') {
    wb.touch(relsPartOf(info.part))
    const id = wb.pkg.addRelationship(info.part, REL_HYPERLINK, target.url, { external: true })
    el.setAttributeNS(NS_R, `${root.lookupPrefix(NS_R) ?? 'r'}:id`, id)
    if (!root.lookupPrefix(NS_R))
      root.setAttributeNS('http://www.w3.org/2000/xmlns/', 'xmlns:r', NS_R)
  } else el.setAttribute('location', target.location)
  if (op.tooltip) el.setAttribute('tooltip', op.tooltip)
  const data = wb.sheet(info.name)
  const anchor = data.cells.get(cellKey(range.top, range.left))
  const shown =
    op.text ??
    (!anchor?.formula && (anchor?.value === null || anchor?.value === undefined)
      ? linkText(target)
      : null)
  if (shown !== null && shown !== '') {
    el.setAttribute('display', shown)
    writeCell(wb, doc, range.top, range.left, { kind: 'value', value: shown })
  }
  list.appendChild(el)
  finishSheet(wb, info, doc)
  stylesDoc(wb)
  restyleRange(wb, info.name, range, (sdoc, cur) =>
    xfWithPatch(sdoc, cur, { font: { underline: true, color: LINK_COLOR } }),
  )
  return [info.name]
}

const linkText = (t: LinkTarget) => (t.kind === 'url' ? t.url.replace(/^mailto:/i, '') : t.location)

/** The place a cell reference text names on `sheet` (for the grid's "go to"). */
export function placeOf(text: string): { row: number; col: number } | null {
  return parseCell(text.replace(/\$/g, ''))
}
