import { hasOfficeSignature } from '../kinds'
import { createCalc, type Calc } from './calc'
import { readDrawing } from './drawing'
import { applyOp, lossesOf, prepareSave, type Loss, type OpResult, type SheetOp } from './ops'
import { openWorkbook, XlsxError, type Images, type Workbook } from './workbook'
import { all } from './xml'

/**
 * One open workbook being edited: operations with undo/redo, calculated
 * values, and the bytes to save. Shared by the Drive's grid (browser) and
 * the drive.sheet_* tools (server).
 */
export type SheetEditor = {
  wb: Workbook
  calc(): Calc
  apply(op: SheetOp, opts?: { acceptLosses?: boolean }): OpResult
  losses(op: SheetOp): Loss[]
  undo(): OpResult | null
  redo(): OpResult | null
  canUndo(): boolean
  canRedo(): boolean
  /** Bumped on every change, undo and redo. */
  version(): number
  changed(): boolean
  /** The workbook as an .xlsx: the original bytes when nothing changed. */
  toBytes(): Uint8Array
}

type Step = { before: Images; after: Images; result: OpResult }

export function createSheetEditor(bytes: Uint8Array): SheetEditor {
  if (!hasOfficeSignature('xlsx', bytes))
    throw new XlsxError('This is not an Excel workbook (.xlsx): it is not a ZIP package.')
  const wb = openWorkbook(bytes)
  const done: Step[] = []
  const undone: Step[] = []
  let version = 0
  let calc: Calc | null = null
  let dirty = false

  const bump = () => {
    version++
    calc = null
    dirty = true
  }

  return {
    wb,
    calc: () => (calc ??= createCalc(wb)),
    apply(op, opts) {
      const { result, images } = applyOp(wb, op, opts)
      done.push({ ...images, result })
      undone.length = 0
      bump()
      return result
    },
    losses: (op) => lossesOf(wb, op),
    undo() {
      const step = done.pop()
      if (!step) return null
      wb.restore(step.before)
      undone.push(step)
      bump()
      return step.result
    },
    redo() {
      const step = undone.pop()
      if (!step) return null
      wb.restore(step.after)
      done.push(step)
      bump()
      return step.result
    },
    canUndo: () => done.length > 0,
    canRedo: () => undone.length > 0,
    version: () => version,
    changed: () => dirty,
    toBytes() {
      if (!dirty) return bytes
      const c = (calc ??= createCalc(wb))
      prepareSave(wb, c)
      calc = null
      return wb.pkg.toBytes()
    },
  }
}

/** What the workbook has that the grid does not show (kept as it is on save), by kind. */
export type WorkbookNote = {
  kind:
    | 'charts'
    | 'drawings'
    | 'pivot_tables'
    | 'comments'
    | 'tables'
    | 'conditional_formats'
    | 'data_validations'
    | 'hidden_sheets'
    | 'chart_sheets'
    | 'formulas_kept'
    | 'macros'
  count: number
  detail?: string
}

export function workbookNotes(ed: SheetEditor): WorkbookNote[] {
  const { wb } = ed
  const out: WorkbookNote[] = []
  const add = (kind: WorkbookNote['kind'], count: number, detail?: string) => {
    if (count > 0) out.push(detail ? { kind, count, detail } : { kind, count })
  }
  const types = wb.pkg.partNames().map((p) => wb.pkg.contentType(p))
  add(
    'charts',
    types.filter((t) => t === 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml')
      .length,
  )
  let drawings = 0
  let cf = 0
  let dv = 0
  const kept = new Map<string, number>()
  for (const s of wb.sheets()) {
    if (s.kind !== 'worksheet') continue
    // Pictures, shapes, text boxes, notes and comments are shown; other drawing content is listed.
    drawings += readDrawing(wb, s).filter((o) => o.kind === 'other' || o.kind === 'frame').length
    const doc = wb.pkg.xml(s.part)
    cf += all(doc, 'conditionalFormatting').length
    dv += all(doc, 'dataValidation').length
    const calc = ed.calc()
    for (const c of wb.sheet(s.name).cells.values()) {
      if (c.formula === null && !c.inArrayOf) continue
      const out = calc.cell(s.name, c.row, c.col)
      if (out.kept) kept.set(out.reason, (kept.get(out.reason) ?? 0) + 1)
    }
  }
  add('drawings', drawings)
  add('conditional_formats', cf)
  add('data_validations', dv)
  add(
    'hidden_sheets',
    wb.sheets().filter((s) => s.state !== 'visible').length,
    wb
      .sheets()
      .filter((s) => s.state !== 'visible')
      .map((s) => s.name)
      .join(', '),
  )
  add('chart_sheets', wb.sheets().filter((s) => s.kind !== 'worksheet').length)
  const keptTotal = [...kept.values()].reduce((a, b) => a + b, 0)
  add('formulas_kept', keptTotal, [...kept.keys()].slice(0, 6).join(', '))
  // .xlsm: the VBA project is kept byte for byte on save and never run.
  add('macros', types.filter((t) => t === 'application/vnd.ms-office.vbaProject').length)
  return out
}
