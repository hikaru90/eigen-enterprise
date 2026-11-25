import { setMerges } from './clip'
import { shiftDecimals } from './format'
import { finishSheet, restyle, sheetDoc, stylesDoc, type Loss, type OpResult } from './ops'
import { cellKey, cellName, rangeName, requireCell, requireRange, type Range } from './ref'
import { checkRuns, isPlain, normalizeRuns, setRichCell, type RichRun } from './rich-text'
import { dropEmptyRow, ensureCell, ensureRow, findCell, findRow, writeCell } from './sheet-xml'
import { xfWithPatch } from './style-records'
import { xfWithNumFmt } from './styles'
import { XlsxError, type SheetData, type Workbook } from './workbook'

/**
 * Merge & Center and its siblings, Clear (all / contents / formats), and rich
 * text in a cell — each one operation on the sheet's XML (mergeCells, the
 * cells' content and format records, the shared strings), everything else
 * left as it is.
 */

export const MERGE_MODES = ['center', 'merge', 'across', 'unmerge'] as const
export type MergeMode = (typeof MERGE_MODES)[number]

/** center: merge & center; merge: merge cells; across: one merge per row; unmerge: split merged cells. */
export type MergeOp = { op: 'merge_cells'; sheet: string; range: string; mode: MergeMode }

export const CLEAR_WHAT = ['all', 'contents', 'formats'] as const
export type ClearWhat = (typeof CLEAR_WHAT)[number]
export type ClearOp = { op: 'clear_range'; sheet: string; range: string; what: ClearWhat }

export type RichTextOp = { op: 'set_rich_text'; sheet: string; ref: string; runs: RichRun[] }

export type ShiftDecimalsOp = {
  op: 'shift_decimals'
  sheet: string
  range: string
  delta: 1 | -1
}

const MAX_CELLS = 100_000

function checkSize(r: Range, what: string) {
  const n = (r.bottom - r.top + 1) * (r.right - r.left + 1)
  if (n > MAX_CELLS)
    throw new XlsxError(`${rangeName(r)} is ${n} cells; ${what} at most ${MAX_CELLS}.`)
}

const meets = (a: Range, b: Range) =>
  a.top <= b.bottom && a.bottom >= b.top && a.left <= b.right && a.right >= b.left

/** The range grown until it holds every merged range it meets (Excel merges them in). */
function grow(range: Range, merges: Range[]): Range {
  const r = { ...range }
  let more = true
  while (more) {
    more = false
    for (const m of merges)
      if (
        meets(m, r) &&
        (m.top < r.top || m.bottom > r.bottom || m.left < r.left || m.right > r.right)
      ) {
        r.top = Math.min(r.top, m.top)
        r.bottom = Math.max(r.bottom, m.bottom)
        r.left = Math.min(r.left, m.left)
        r.right = Math.max(r.right, m.right)
        more = true
      }
  }
  return r
}

/** The merged blocks a merge op makes. */
function blocksOf(op: MergeOp, data: SheetData): Range[] {
  const range = grow(requireRange(op.range), data.merges)
  if (op.mode === 'across') {
    const out: Range[] = []
    for (let r = range.top; r <= range.bottom; r++)
      if (range.right > range.left)
        out.push({ top: r, bottom: r, left: range.left, right: range.right })
    return out
  }
  return range.top === range.bottom && range.left === range.right ? [] : [range]
}

const filled = (data: SheetData, r: number, c: number) => {
  const x = data.cells.get(cellKey(r, c))
  return !!x && (x.value !== null || x.formula !== null)
}

/** Merging keeps only the upper-left value of each block: the others are named before. */
export function mergeLosses(wb: Workbook, op: MergeOp): Loss[] {
  if (op.mode === 'unmerge') return []
  const data = wb.sheet(wb.requireWorksheet(op.sheet).name)
  let n = 0
  for (const b of blocksOf(op, data))
    for (let r = b.top; r <= b.bottom; r++)
      for (let c = b.left; c <= b.right; c++)
        if ((r !== b.top || c !== b.left) && filled(data, r, c)) n++
  return n > 0 ? [{ feature: 'merged_values', count: n }] : []
}

export function runMerge(wb: Workbook, op: MergeOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const data = wb.sheet(info.name)
  const asked = requireRange(op.range)
  checkSize(asked, 'merge')
  const doc = sheetDoc(wb, info)
  if (op.mode === 'unmerge') {
    const rest = data.merges.filter((m) => !meets(m, asked))
    if (rest.length === data.merges.length) return { sheets: [] }
    setMerges(doc, rest)
    finishSheet(wb, info, doc)
    return { sheets: [info.name] }
  }
  const blocks = blocksOf(op, data)
  if (blocks.length === 0) return { sheets: [] }
  for (const b of blocks)
    for (const cell of data.cells.values())
      if (cell.formulaRef && meets(cell.formulaRef, b) && !cell.dynamic)
        throw new XlsxError(`${rangeName(b)} holds part of an array formula; merged cells can't.`)
  let sdoc: XMLDocument | null = null
  const centered = new Map<number, number>()
  for (const b of blocks) {
    const anchor = data.cells.get(cellKey(b.top, b.left))
    let style = anchor?.style ?? 0
    if (op.mode === 'center' || op.mode === 'across') {
      if (op.mode === 'center') {
        sdoc ??= stylesDoc(wb)
        let next = centered.get(style)
        if (next === undefined) {
          next = xfWithPatch(sdoc, style, { horizontal: 'center' })
          centered.set(style, next)
        }
        style = next
      }
    }
    for (let r = b.top; r <= b.bottom; r++)
      for (let c = b.left; c <= b.right; c++) {
        if (r === b.top && c === b.left) {
          if (style !== (anchor?.style ?? 0)) restyle(wb, doc, r, c, style)
          continue
        }
        // The other cells lose their content and take the block's format (as Excel).
        if (filled(data, r, c)) writeCell(wb, doc, r, c, { kind: 'clear' }, style)
        else if ((data.cells.get(cellKey(r, c))?.style ?? 0) !== style)
          restyle(wb, doc, r, c, style)
      }
  }
  const kept = data.merges.filter((m) => !blocks.some((b) => meets(m, b)))
  setMerges(doc, [...kept, ...blocks])
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

export function runClear(wb: Workbook, op: ClearOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const range = requireRange(op.range)
  const data = wb.sheet(info.name)
  if (!['all', 'contents', 'formats'].includes(op.what))
    throw new XlsxError(`“${op.what}” is not something to clear (all, contents, formats).`)
  for (const cell of data.cells.values()) {
    if (!meets({ top: cell.row, bottom: cell.row, left: cell.col, right: cell.col }, range))
      continue
    if (op.what === 'formats') continue
    const arr = cell.formulaType === 'array' && !cell.dynamic ? cell.formulaRef : cell.inArrayOf
    if (
      arr &&
      !data.cells.get(cellKey(arr.top, arr.left))?.dynamic &&
      !(
        arr.top >= range.top &&
        arr.bottom <= range.bottom &&
        arr.left >= range.left &&
        arr.right <= range.right
      )
    )
      throw new XlsxError(
        `${info.name}!${cellName(cell)} is part of the array formula in ${rangeName(arr)}, which can only be cleared as a whole.`,
      )
  }
  const doc = sheetDoc(wb, info)
  let any = false
  for (const cell of [...data.cells.values()]) {
    if (!meets({ top: cell.row, bottom: cell.row, left: cell.col, right: cell.col }, range))
      continue
    const rowEl = findRow(doc, cell.row)
    const el = rowEl ? findCell(rowEl, cell.col) : null
    if (!el) continue
    any = true
    if (op.what === 'contents') {
      if (cell.value !== null || cell.formula !== null)
        writeCell(wb, doc, cell.row, cell.col, { kind: 'clear' })
    } else if (op.what === 'formats') restyle(wb, doc, cell.row, cell.col, 0)
    else {
      rowEl!.removeChild(el)
      dropEmptyRow(rowEl!)
    }
  }
  // Clearing formats or everything also splits merged cells inside (as Excel).
  if (op.what !== 'contents') {
    const rest = data.merges.filter((m) => !meets(m, range))
    if (rest.length !== data.merges.length) {
      setMerges(doc, rest)
      any = true
    }
  }
  if (!any) return { sheets: [] }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

export function runRichText(wb: Workbook, op: RichTextOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const addr = requireCell(op.ref)
  const where = `${info.name}!${cellName(addr)}`
  checkRuns(op.runs, where)
  const data = wb.sheet(info.name)
  const cur = data.cells.get(cellKey(addr.row, addr.col))
  if (cur?.inArrayOf || (cur?.formulaType === 'array' && !cur.dynamic))
    throw new XlsxError(`${where} is part of an array formula.`)
  const merge = data.merges.find(
    (m) =>
      addr.row >= m.top &&
      addr.row <= m.bottom &&
      addr.col >= m.left &&
      addr.col <= m.right &&
      (m.top !== addr.row || m.left !== addr.col),
  )
  if (merge) throw new XlsxError(`${where} is inside the merged cells ${rangeName(merge)}.`)
  const runs = normalizeRuns(op.runs)
  const doc = sheetDoc(wb, info)
  const text = runs.map((r) => r.text).join('')
  if (text === '') writeCell(wb, doc, addr.row, addr.col, { kind: 'clear' })
  else if (isPlain(runs)) writeCell(wb, doc, addr.row, addr.col, { kind: 'value', value: text })
  else setRichCell(wb, ensureCell(doc, ensureRow(doc, addr.row), addr.row, addr.col), runs)
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}

export function runShiftDecimals(wb: Workbook, op: ShiftDecimalsOp): OpResult {
  const info = wb.requireWorksheet(op.sheet)
  const range = requireRange(op.range)
  checkSize(range, 'change decimals for')
  const data = wb.sheet(info.name)
  const styles = wb.styles()
  const doc = sheetDoc(wb, info)
  const sdoc = stylesDoc(wb)
  const memo = new Map<string, number>()
  let any = false
  for (let r = range.top; r <= range.bottom; r++) {
    for (let c = range.left; c <= range.right; c++) {
      const cell = data.cells.get(cellKey(r, c))
      const cur = cell?.style ?? 0
      const st = styles.xf(cur)
      const sample = typeof cell?.value === 'number' ? cell.value : undefined
      const nextCode = shiftDecimals(st.numFmt, op.delta, sample)
      if (nextCode === st.numFmt) continue
      const key = `${cur}|${nextCode}`
      let next = memo.get(key)
      if (next === undefined) {
        next = xfWithNumFmt(sdoc, cur, nextCode)
        memo.set(key, next)
      }
      if (next !== cur) {
        restyle(wb, doc, r, c, next)
        any = true
      }
    }
  }
  if (!any) return { sheets: [] }
  finishSheet(wb, info, doc)
  return { sheets: [info.name] }
}
