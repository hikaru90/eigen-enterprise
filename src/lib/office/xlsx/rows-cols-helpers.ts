import type { SheetInfo, Workbook } from './workbook'
import { rangeName } from './ref'
import { setDimension } from './sheet-xml'

/** Internal helper to refresh sheet dimensions and invalidate caches after row/col XML edits. */
export function finishSheet(wb: Workbook, info: SheetInfo, doc: XMLDocument) {
  wb.forgetSheet(info.part)
  const d = wb.sheet(info.name)
  setDimension(
    doc,
    d.maxRow < 0 ? 'A1' : rangeName({ top: 0, left: 0, bottom: d.maxRow, right: d.maxCol }),
  )
  wb.forgetSheet(info.part)
}

export const setSheetRowColOp = true
