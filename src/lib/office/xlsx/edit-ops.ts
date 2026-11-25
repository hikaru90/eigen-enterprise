import type { Loss, OpResult } from './ops'
import type { Workbook } from './workbook'
import {
  mergeLosses,
  runClear,
  runMerge,
  runRichText,
  runShiftDecimals,
  type ClearOp,
  type MergeOp,
  type RichTextOp,
  type ShiftDecimalsOp,
} from './cells-edit'
import { runPaste, type PasteOp } from './clip'
import { runFill, type FillOp } from './fill'
import { runReplace, type ReplaceOp } from './find'
import { runPrintOp, type PageSetupOp, type ViewOptionsOp } from './print'
import { runRowsColsOp, type RowsColsOp } from './rows-cols'
import { runSheetTabOp, sheetTabLosses, type SheetTabOp } from './sheet-tabs'

/**
 * Dispatcher for everyday editing operations wired into ./ops.ts:
 * clipboard paste/cut, fill series, find & replace, merge/unmerge, clear,
 * rich text, decimal shift, rows/cols hide/group/autofit, sheet tabs,
 * page setup and view options.
 */

export type EditOp =
  | PasteOp
  | FillOp
  | ReplaceOp
  | MergeOp
  | ClearOp
  | RichTextOp
  | ShiftDecimalsOp
  | RowsColsOp
  | SheetTabOp
  | PageSetupOp
  | ViewOptionsOp

export function editLosses(wb: Workbook, op: EditOp): Loss[] {
  switch (op.op) {
    case 'merge_cells':
      return mergeLosses(wb, op)
    case 'duplicate_sheet':
      return sheetTabLosses(wb, op)
    default:
      return []
  }
}

export function runEditOp(wb: Workbook, op: EditOp): OpResult {
  switch (op.op) {
    case 'paste':
      return runPaste(wb, op)
    case 'fill':
      return runFill(wb, op)
    case 'replace':
      return runReplace(wb, op)
    case 'merge_cells':
      return runMerge(wb, op)
    case 'clear_range':
      return runClear(wb, op)
    case 'set_rich_text':
      return runRichText(wb, op)
    case 'shift_decimals':
      return runShiftDecimals(wb, op)
    case 'hide_columns':
    case 'hide_rows':
    case 'group_columns':
    case 'ungroup_columns':
    case 'group_rows':
    case 'ungroup_rows':
    case 'collapse_columns':
    case 'collapse_rows':
    case 'set_outline_level':
    case 'autofit_columns':
    case 'autofit_rows':
      return runRowsColsOp(wb, op)
    case 'move_sheet':
    case 'set_sheet_color':
    case 'set_sheet_visibility':
    case 'duplicate_sheet':
      return runSheetTabOp(wb, op)
    case 'set_page_setup':
    case 'set_view_options':
      return runPrintOp(wb, op)
  }
}
