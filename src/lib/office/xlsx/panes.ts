import { cellName, MAX_COLS, MAX_ROWS, parseCell } from './ref'
import { WORKSHEET_ORDER } from './sheet-order'
import { XlsxError, type Workbook } from './workbook'
import { insertInOrder, kid, kids, make } from './xml'

/**
 * Frozen panes (ECMA-376 Part 1 §18.3.1.66 pane, §18.3.1.87 sheetView): the
 * rows above and the columns left of a split stay in place while the rest
 * scrolls. Written on the sheet's first view as Excel writes it — a `pane`
 * with `state="frozen"`, the split counts, the first scrolling cell and the
 * active pane, and an empty selection per pane — and nothing else of the
 * view changes.
 */

export type FreezeOp = { op: 'freeze_panes'; sheet: string; rows: number; cols: number }

/** How many rows (from the top) and columns (from the left) stay in place. */
export type Frozen = { rows: number; cols: number }

function firstView(root: Element): Element | null {
  const views = kid(root, 'sheetViews')
  return views ? (kids(views, 'sheetView')[0] ?? null) : null
}

/** The sheet's frozen panes, or null. A view scrolled before freezing counts from its first row/column (the grid freezes from the top). */
export function frozenOf(wb: Workbook, sheet: string): Frozen | null {
  const info = wb.requireWorksheet(sheet)
  const view = firstView(wb.pkg.xml(info.part).documentElement!)
  const pane = view ? kid(view, 'pane') : null
  const state = pane?.getAttribute('state')
  if (!pane || (state !== 'frozen' && state !== 'frozenSplit')) return null
  const ySplit = Math.max(0, Math.floor(Number(pane.getAttribute('ySplit') ?? 0)))
  const xSplit = Math.max(0, Math.floor(Number(pane.getAttribute('xSplit') ?? 0)))
  if (!ySplit && !xSplit) return null
  const start = parseCell(view!.getAttribute('topLeftCell') ?? 'A1') ?? { row: 0, col: 0 }
  return { rows: ySplit ? start.row + ySplit : 0, cols: xSplit ? start.col + xSplit : 0 }
}

export function freezePanes(doc: XMLDocument, op: FreezeOp) {
  const { rows, cols } = op
  if (!Number.isInteger(rows) || rows < 0 || rows >= MAX_ROWS)
    throw new XlsxError(`${rows} rows can't be frozen.`)
  if (!Number.isInteger(cols) || cols < 0 || cols >= MAX_COLS)
    throw new XlsxError(`${cols} columns can't be frozen.`)
  const root = doc.documentElement!
  let views = kid(root, 'sheetViews')
  if (!views) {
    if (!rows && !cols) return
    views = make(doc, 'sheetViews')
    insertInOrder(root, views, WORKSHEET_ORDER)
  }
  let view = kids(views, 'sheetView')[0]
  if (!view) {
    view = make(doc, 'sheetView')
    view.setAttribute('workbookViewId', '0')
    views.insertBefore(view, views.firstChild)
  }
  // The old split and the selections of its panes go; the top-left selection stays.
  for (const k of kids(view, 'pane')) view.removeChild(k)
  for (const s of kids(view, 'selection')) {
    const p = s.getAttribute('pane')
    if (p && p !== 'topLeft') view.removeChild(s)
  }
  if (!rows && !cols) return
  // Frozen from the top: the view starts at A1.
  view.removeAttribute('topLeftCell')
  const active = rows && cols ? 'bottomRight' : rows ? 'bottomLeft' : 'topRight'
  const pane = make(doc, 'pane')
  if (cols) pane.setAttribute('xSplit', String(cols))
  if (rows) pane.setAttribute('ySplit', String(rows))
  pane.setAttribute('topLeftCell', cellName({ row: rows, col: cols }))
  pane.setAttribute('activePane', active)
  pane.setAttribute('state', 'frozen')
  view.insertBefore(pane, view.firstChild)
  const panes = rows && cols ? ['topRight', 'bottomLeft', 'bottomRight'] : [active]
  let after: Node = pane
  for (const p of panes) {
    const sel = make(doc, 'selection')
    sel.setAttribute('pane', p)
    view.insertBefore(sel, after.nextSibling)
    after = sel
  }
}
