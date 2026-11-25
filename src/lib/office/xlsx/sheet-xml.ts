import { cellName, parseCell } from './ref'
import { isErrorValue, XlsxError, type CellValue, type Workbook } from './workbook'
import { kid, kids, make, removeAll, setText } from './xml'

/**
 * Edits of a worksheet part's XML (CT_Worksheet, ECMA-376 Part 1 §18.3):
 * rows and cells found or made in order, a cell's content replaced, shared
 * formulas written out per cell. Callers hold the sheet's document from
 * `Workbook.edit` (inside a transaction).
 */

export type CellContent =
  | { kind: 'clear' }
  | { kind: 'value'; value: Exclude<CellValue, null> }
  | { kind: 'formula'; formula: string }

const rowIndex = (el: Element) => Number(el.getAttribute('r')) - 1

export function sheetDataOf(doc: XMLDocument): Element {
  const el = kid(doc.documentElement!, 'sheetData')
  if (!el) throw new XlsxError('The sheet has no cell data (sheetData).')
  return el
}

/** Gives every row and cell its r attribute (rows and cells may leave it out, §18.3.1.73): positions become explicit before anything moves. */
export function normalizeRefs(doc: XMLDocument) {
  let r = 0
  for (const row of kids(sheetDataOf(doc), 'row')) {
    const ra = row.getAttribute('r')
    r = ra ? Number(ra) : r + 1
    row.setAttribute('r', String(r))
    let c = -1
    for (const cell of kids(row, 'c')) {
      const ca = cell.getAttribute('r')
      const addr = ca ? parseCell(ca) : null
      c = addr ? addr.col : c + 1
      cell.setAttribute('r', cellName({ row: r - 1, col: c }))
    }
  }
}

export function findRow(doc: XMLDocument, row: number): Element | null {
  for (const el of kids(sheetDataOf(doc), 'row')) {
    const i = rowIndex(el)
    if (i === row) return el
    if (i > row) return null
  }
  return null
}

export function ensureRow(doc: XMLDocument, row: number): Element {
  const data = sheetDataOf(doc)
  for (const el of kids(data, 'row')) {
    const i = rowIndex(el)
    if (i === row) return el
    if (i > row) {
      const fresh = make(doc, 'row')
      fresh.setAttribute('r', String(row + 1))
      data.insertBefore(fresh, el)
      return fresh
    }
  }
  const fresh = make(doc, 'row')
  fresh.setAttribute('r', String(row + 1))
  data.appendChild(fresh)
  return fresh
}

const colOf = (cell: Element) => parseCell(cell.getAttribute('r') ?? '')!.col

export function findCell(rowEl: Element, col: number): Element | null {
  for (const c of kids(rowEl, 'c')) {
    const i = colOf(c)
    if (i === col) return c
    if (i > col) return null
  }
  return null
}

export function ensureCell(doc: XMLDocument, rowEl: Element, row: number, col: number): Element {
  // The row's spans hint (§18.3.1.73) would go stale; it is optional.
  rowEl.removeAttribute('spans')
  for (const c of kids(rowEl, 'c')) {
    const i = colOf(c)
    if (i === col) return c
    if (i > col) {
      const fresh = make(doc, 'c')
      fresh.setAttribute('r', cellName({ row, col }))
      rowEl.insertBefore(fresh, c)
      return fresh
    }
  }
  const fresh = make(doc, 'c')
  fresh.setAttribute('r', cellName({ row, col }))
  rowEl.appendChild(fresh)
  return fresh
}

/** Removes a cell's content (formula, value, inline text, type, value/cell metadata); its format stays. */
function clearContent(cell: Element) {
  for (const k of kids(cell, undefined))
    if (k.localName === 'f' || k.localName === 'v' || k.localName === 'is') cell.removeChild(k)
  cell.removeAttribute('t')
  cell.removeAttribute('cm')
  cell.removeAttribute('vm')
}

/** Puts `content` into the cell; `style` (a cellXfs index) replaces its format when given. */
export function writeCell(
  wb: Workbook,
  doc: XMLDocument,
  row: number,
  col: number,
  content: CellContent,
  style?: number,
) {
  if (content.kind === 'clear') {
    const rowEl = findRow(doc, row)
    const cell = rowEl ? findCell(rowEl, col) : null
    if (!cell) {
      if (style !== undefined && style !== 0)
        applyStyle(ensureCell(doc, ensureRow(doc, row), row, col), style)
      return
    }
    clearContent(cell)
    if (style !== undefined) applyStyle(cell, style)
    if (!cell.getAttribute('s') || cell.getAttribute('s') === '0') {
      rowEl!.removeChild(cell)
      dropEmptyRow(rowEl!)
    }
    return
  }
  const cell = ensureCell(doc, ensureRow(doc, row), row, col)
  clearContent(cell)
  if (style !== undefined) applyStyle(cell, style)
  if (content.kind === 'formula') {
    const f = make(doc, 'f')
    setText(doc, f, content.formula)
    cell.insertBefore(f, cell.firstChild)
    return
  }
  const v = make(doc, 'v')
  const value = content.value
  if (typeof value === 'string') {
    cell.setAttribute('t', 's')
    v.appendChild(doc.createTextNode(String(wb.sharedStringIndex(value))))
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value))
      throw new XlsxError(`${cellName({ row, col })}: ${value} is not a number a cell can hold.`)
    v.appendChild(doc.createTextNode(String(value)))
  } else if (typeof value === 'boolean') {
    cell.setAttribute('t', 'b')
    v.appendChild(doc.createTextNode(value ? '1' : '0'))
  } else if (isErrorValue(value)) {
    cell.setAttribute('t', 'e')
    v.appendChild(doc.createTextNode(value.error))
  }
  cell.insertBefore(v, kid(cell, 'extLst'))
}

function applyStyle(cell: Element, style: number) {
  if (style === 0) cell.removeAttribute('s')
  else cell.setAttribute('s', String(style))
}

/** A row without cells and without its own height, format or visibility goes. */
export function dropEmptyRow(rowEl: Element) {
  if (kids(rowEl, 'c').length > 0) return
  for (let i = 0; i < rowEl.attributes.length; i++) {
    const n = rowEl.attributes[i]!.localName
    if (n !== 'r' && n !== 'spans' && n !== 'x14ac:dyDescent' && n !== 'dyDescent') return
  }
  rowEl.parentNode?.removeChild(rowEl)
}

/**
 * Writes every shared formula of the sheet out as a plain formula per cell
 * (same meaning), so cells can move or change without the group: `formulaOf`
 * is the expanded text per cell address.
 */
export function unshareFormulas(
  doc: XMLDocument,
  formulaOf: (ref: string) => string | null,
): boolean {
  let any = false
  for (const row of kids(sheetDataOf(doc), 'row')) {
    for (const cell of kids(row, 'c')) {
      const f = kid(cell, 'f')
      if (!f || f.getAttribute('t') !== 'shared') continue
      const text = formulaOf(cell.getAttribute('r')!)
      if (text === null) continue
      any = true
      const plain = make(doc, 'f')
      setText(doc, plain, text)
      cell.replaceChild(plain, f)
    }
  }
  return any
}

/** Sets the sheet's dimension (§18.3.1.35) to its used range, when it has the element. */
export function setDimension(doc: XMLDocument, ref: string) {
  const dim = kid(doc.documentElement!, 'dimension')
  if (dim) dim.setAttribute('ref', ref)
}

export { removeAll }
