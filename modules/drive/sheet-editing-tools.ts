import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { CLEAR_WHAT, MERGE_MODES } from '$lib/office/xlsx/cells-edit'
import { PASTE_MODES } from '$lib/office/xlsx/clip'
import { FILL_SERIES } from '$lib/office/xlsx/fill'
import type { SheetOp } from '$lib/office/xlsx/ops'
import { PAPER_SIZES } from '$lib/office/xlsx/print'
import type { ExportPdfDeps } from '$lib/office/xlsx/print-pdf'
import { DRIVE_MODULE_ID } from './manifest'
import { DriveError } from './service'
import {
  colIndex,
  column,
  DRIVE_ROLES,
  fileId,
  guarded,
  nameOf,
  openBook,
  plural,
  save,
  sheetName,
  xlsx,
  type DriveSheetToolDeps,
  type Xlsx,
} from './sheet-tools'

/**
 * Everyday spreadsheet editing as kernel registry tools:
 * - drive.sheet_copy_range   copy / cut / paste & paste special (within, across sheets or workbooks)
 * - drive.sheet_fill         AutoFill & Fill Series
 * - drive.sheet_find_replace find and/or replace (values or formulas, match case, whole cell, wildcards)
 * - drive.sheet_merge        Merge & Center / Merge / Merge Across / Unmerge, Clear, Rich Text, Decimals
 * - drive.sheet_rows_cols    hide/unhide, group/ungroup, collapse/expand, outline level, autofit width/height
 * - drive.sheet_tab          reorder, tab colour, hide/unhide/veryHidden, duplicate, view options, page setup
 * - drive.sheet_export_pdf   render workbook / sheet to PDF via Chromium (read, saves nothing)
 */

const editingLib = async () => {
  const [clip, fill, find, cellsEdit, richText, rowsCols, sheetTabs, print] = await Promise.all([
    import('$lib/office/xlsx/clip'),
    import('$lib/office/xlsx/fill'),
    import('$lib/office/xlsx/find'),
    import('$lib/office/xlsx/cells-edit'),
    import('$lib/office/xlsx/rich-text'),
    import('$lib/office/xlsx/rows-cols'),
    import('$lib/office/xlsx/sheet-tabs'),
    import('$lib/office/xlsx/print'),
  ])
  return { clip, fill, find, cellsEdit, richText, rowsCols, sheetTabs, print }
}

const rangeText = z.string().min(2).max(30)
const cellRef = z.string().min(2).max(12)
const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .describe('A colour like #1F4E79')
const localeSchema = z.enum(['en', 'de'])

const copyRangeInput = z
  .object({
    file_id: fileId,
    source_sheet: sheetName,
    source_range: rangeText.describe('Cells to copy or cut, like A1:C5'),
    target_sheet: sheetName.optional().describe('Destination sheet (defaults to source_sheet)'),
    to: rangeText.describe('Destination top-left cell or target range, like D1 or D1:F5'),
    source_file_id: fileId
      .optional()
      .describe('Optional source workbook id when copying from another .xlsx file (cannot cut)'),
    cut: z.boolean().optional().describe('Move the cells instead of copying (same workbook only)'),
    mode: z
      .enum(PASTE_MODES)
      .optional()
      .describe('Paste mode: all (default), values, formulas, formats'),
    transpose: z.boolean().optional().describe('Swap rows and columns when pasting'),
    skip_blanks: z
      .boolean()
      .optional()
      .describe('Do not overwrite target cells with blank source cells'),
    locale: localeSchema.optional(),
  })
  .strict()

const fillInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    source: rangeText.describe('Seed cells inside target, like A1:A2'),
    target: rangeText.describe('Full destination range containing source, like A1:A10'),
    series: z.enum(FILL_SERIES).optional().describe('Fill mode (default auto)'),
    step: z.number().finite().optional().describe('Step value for linear/growth/date series'),
    stop: z.number().finite().optional().describe('Optional numeric/date stop limit'),
    custom_lists: z
      .array(z.array(z.string().min(1).max(100)).min(1).max(100))
      .max(20)
      .optional()
      .describe('Optional custom text lists matched before falling back to repeat'),
  })
  .strict()

const findReplaceInput = z
  .object({
    file_id: fileId,
    find: z.string().min(1).max(1000).describe('Text or Excel wildcard (*, ?, ~) to find'),
    replace: z
      .string()
      .max(1000)
      .optional()
      .describe('Replacement text; omit to only list matching cells without modifying the file'),
    sheet: sheetName.optional().describe('Limit to one sheet (omit for all worksheets)'),
    look_in: z
      .enum(['formulas', 'values'])
      .optional()
      .describe('Search formulas/input (default) or formatted display values'),
    match_case: z.boolean().optional(),
    whole_cell: z.boolean().optional(),
    cells: z
      .array(z.object({ sheet: sheetName, ref: cellRef }).strict())
      .max(5000)
      .optional()
      .describe('Restrict replacement to specific matched cells'),
    locale: localeSchema.optional(),
  })
  .strict()

const richRunSchema = z
  .object({
    text: z.string().min(1).max(32_767),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional(),
    color: hexColor.optional(),
    size: z.number().min(1).max(409).optional(),
    font: z.string().min(1).max(31).optional(),
  })
  .strict()

const mergeInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    range: rangeText.optional().describe('Target cell range for merge, clear, or shift_decimals'),
    mode: z
      .enum(MERGE_MODES)
      .optional()
      .describe('center (Merge & Center), merge, across (row by row), or unmerge'),
    clear: z.enum(CLEAR_WHAT).optional().describe('Clear all, contents, or formats in range'),
    shift_decimals: z
      .union([z.literal(1), z.literal(-1)])
      .optional()
      .describe('1 increases decimals by one digit; -1 decreases by one digit'),
    rich_text: z
      .object({
        ref: cellRef,
        runs: z.array(richRunSchema).min(1).max(500),
      })
      .strict()
      .optional()
      .describe('Set mixed-format rich-text runs inside a single cell'),
    accept_losses: z
      .boolean()
      .optional()
      .describe(
        'Merge even when lower/right non-empty cell values inside the merge would be cleared',
      ),
  })
  .strict()

const rowNum = z.number().int().min(1).describe('Row number (1 = top)')

const rowColChange = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('hide_columns'),
      from: column,
      to: column.optional(),
      hidden: z.boolean().default(true),
    })
    .strict(),
  z
    .object({
      action: z.literal('hide_rows'),
      from: rowNum,
      to: rowNum.optional(),
      hidden: z.boolean().default(true),
    })
    .strict(),
  z.object({ action: z.literal('group_columns'), from: column, to: column.optional() }).strict(),
  z.object({ action: z.literal('ungroup_columns'), from: column, to: column.optional() }).strict(),
  z.object({ action: z.literal('group_rows'), from: rowNum, to: rowNum.optional() }).strict(),
  z.object({ action: z.literal('ungroup_rows'), from: rowNum, to: rowNum.optional() }).strict(),
  z
    .object({
      action: z.literal('collapse_columns'),
      from: column,
      to: column.optional(),
      collapsed: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('collapse_rows'),
      from: rowNum,
      to: rowNum.optional(),
      collapsed: z.boolean(),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_outline_level'),
      axis: z.enum(['row', 'col']),
      level: z.number().int().min(1).max(8),
    })
    .strict(),
  z
    .object({
      action: z.literal('autofit_columns'),
      from: column,
      to: column.optional(),
      locale: localeSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('autofit_rows'),
      from: rowNum,
      to: rowNum.optional(),
      locale: localeSchema.optional(),
    })
    .strict(),
])

const rowsColsInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    changes: z.array(rowColChange).min(1).max(100),
  })
  .strict()

const pageMarginsSchema = z
  .object({
    top: z.number().min(0).max(10).optional(),
    bottom: z.number().min(0).max(10).optional(),
    left: z.number().min(0).max(10).optional(),
    right: z.number().min(0).max(10).optional(),
    header: z.number().min(0).max(10).optional(),
    footer: z.number().min(0).max(10).optional(),
  })
  .strict()

const tabInput = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('move_sheet'),
      file_id: fileId,
      sheet: sheetName,
      position: z.number().int().min(1).describe('1-based target tab position'),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_sheet_color'),
      file_id: fileId,
      sheet: sheetName,
      color: hexColor.nullable().describe('#RRGGBB tab colour, or null to clear'),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_sheet_visibility'),
      file_id: fileId,
      sheet: sheetName,
      state: z.enum(['visible', 'hidden', 'veryHidden']),
    })
    .strict(),
  z
    .object({
      action: z.literal('duplicate_sheet'),
      file_id: fileId,
      sheet: sheetName,
      name: sheetName.optional().describe('Optional new sheet name'),
      position: z.number().int().min(1).optional().describe('Optional 1-based tab position'),
      accept_losses: z
        .boolean()
        .optional()
        .describe('Duplicate even if drawings/tables/comments are not copied'),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_view_options'),
      file_id: fileId,
      sheet: sheetName,
      show_gridlines: z.boolean().optional(),
      show_headings: z.boolean().optional(),
      zoom_scale: z.number().int().min(10).max(400).optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('set_page_setup'),
      file_id: fileId,
      sheet: sheetName,
      orientation: z.enum(['portrait', 'landscape']).optional(),
      paper_size: z.enum(PAPER_SIZES).optional(),
      scale: z.number().int().min(10).max(400).optional(),
      fit_to_width: z.number().int().min(0).max(99).nullable().optional(),
      fit_to_height: z.number().int().min(0).max(99).nullable().optional(),
      margins: pageMarginsSchema.optional(),
      print_gridlines: z.boolean().optional(),
      print_headings: z.boolean().optional(),
      center_horizontally: z.boolean().optional(),
      center_vertically: z.boolean().optional(),
      print_area: rangeText.nullable().optional(),
      repeat_rows: z.string().min(1).max(20).nullable().optional(),
      repeat_cols: z.string().min(1).max(20).nullable().optional(),
    })
    .strict(),
])

const exportPdfInput = z
  .object({
    file_id: fileId,
    sheet: sheetName.optional().describe('One sheet to export; omit for all visible worksheets'),
    locale: localeSchema.optional(),
    orientation: z.enum(['portrait', 'landscape']).optional(),
    paper_size: z.enum(PAPER_SIZES).optional(),
    fit_to_width: z.number().int().min(0).max(99).nullable().optional(),
    print_gridlines: z.boolean().optional(),
    print_headings: z.boolean().optional(),
  })
  .strict()

function rowColToOp(lib: Xlsx, sheet: string, c: z.infer<typeof rowColChange>): SheetOp {
  switch (c.action) {
    case 'hide_columns':
      return {
        op: 'hide_columns',
        sheet,
        from: colIndex(lib, c.from),
        to: colIndex(lib, c.to ?? c.from),
        hidden: c.hidden,
      }
    case 'hide_rows':
      return {
        op: 'hide_rows',
        sheet,
        from: c.from - 1,
        to: (c.to ?? c.from) - 1,
        hidden: c.hidden,
      }
    case 'group_columns':
    case 'ungroup_columns':
      return {
        op: c.action,
        sheet,
        from: colIndex(lib, c.from),
        to: colIndex(lib, c.to ?? c.from),
      }
    case 'group_rows':
    case 'ungroup_rows':
      return {
        op: c.action,
        sheet,
        from: c.from - 1,
        to: (c.to ?? c.from) - 1,
      }
    case 'collapse_columns':
      return {
        op: 'collapse_columns',
        sheet,
        from: colIndex(lib, c.from),
        to: colIndex(lib, c.to ?? c.from),
        collapsed: c.collapsed,
      }
    case 'collapse_rows':
      return {
        op: 'collapse_rows',
        sheet,
        from: c.from - 1,
        to: (c.to ?? c.from) - 1,
        collapsed: c.collapsed,
      }
    case 'set_outline_level':
      return { op: 'set_outline_level', sheet, axis: c.axis, level: c.level }
    case 'autofit_columns':
      return {
        op: 'autofit_columns',
        sheet,
        from: colIndex(lib, c.from),
        to: colIndex(lib, c.to ?? c.from),
        ...(c.locale ? { locale: c.locale } : {}),
      }
    case 'autofit_rows':
      return {
        op: 'autofit_rows',
        sheet,
        from: c.from - 1,
        to: (c.to ?? c.from) - 1,
        ...(c.locale ? { locale: c.locale } : {}),
      }
  }
}

export type DriveSheetEditingToolDeps = DriveSheetToolDeps & { pdfDeps?: ExportPdfDeps }

export function createDriveSheetEditingTools({
  service,
  sheetLive,
  pdfDeps,
}: DriveSheetEditingToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_copy_range',
      module: DRIVE_MODULE_ID,
      summary:
        'Copy or cut cells from one range to another in an Excel workbook (.xlsx) in Drive (same sheet, another sheet, or another source_file_id workbook): supports paste modes all (default), values, formulas, formats, transpose, skip_blanks, and cut (moves cells and updates incoming formulas within the same workbook). Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof copyRangeInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to copy cells in file ${input.file_id} in Drive`
        const verb = input.cut ? 'Moved' : 'Copied'
        const dest = input.target_sheet ? `${input.target_sheet}!${input.to}` : input.to
        return `${verb} ${input.source_sheet}!${input.source_range} to ${dest} in ${name} in Drive`
      },
      inputSchema: copyRangeInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = copyRangeInput.parse(input)
        const crossBook = i.source_file_id !== undefined && i.source_file_id !== i.file_id
        if (crossBook && i.cut)
          throw new DriveError('invalid', 'Cut cells can only be moved within the same workbook.')
        const drive = await service()
        const lib = await xlsx()
        const eLib = await editingLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const srcEditor = crossBook
          ? (await openBook(drive, ctx, i.source_file_id!, lib, sheetLive)).editor
          : editor
        const targetSheet = i.target_sheet ?? i.source_sheet
        let pasted = 0
        await guarded(lib, () => {
          const range = lib.ref.requireRange(i.source_range)
          const rawClip = eLib.clip.readClip(
            srcEditor,
            i.source_sheet,
            range,
            i.source_file_id ?? i.file_id,
            i.locale ?? 'en',
          )
          const clip = crossBook ? eLib.clip.foreignClip(rawClip) : rawClip
          pasted = clip.rows * clip.cols
          editor.apply({
            op: 'paste',
            sheet: targetSheet,
            at: i.to,
            clip,
            paste: i.mode ?? 'all',
            ...(i.transpose ? { transpose: true } : {}),
            ...(i.skip_blanks ? { skipBlanks: true } : {}),
            ...(i.cut ? { cut: true } : {}),
          })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return {
          ...saved,
          pasted,
          source_sheet: srcEditor.wb.requireWorksheet(i.source_sheet).name,
          source_range: i.source_range,
          target_sheet: editor.wb.requireWorksheet(targetSheet).name,
          to: i.to,
        }
      },
    },
    {
      name: 'drive.sheet_fill',
      module: DRIVE_MODULE_ID,
      summary:
        'AutoFill or Fill Series in an Excel workbook (.xlsx) in Drive (file_id, sheet, source range inside target range, series: auto | copy | linear | growth | days | weekdays | months | years, optional step, stop, custom_lists). Preserves relative formula shifting, dates/1904 dates, and cell formats. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof fillInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Filled ${input.target} from ${input.source} in ${input.sheet} of ${name} in Drive`
          : `Tried to fill cells in file ${input.file_id} in Drive`
      },
      inputSchema: fillInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = fillInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          editor.apply({
            op: 'fill',
            sheet: i.sheet,
            source: i.source,
            target: i.target,
            ...(i.series ? { series: i.series } : {}),
            ...(i.step !== undefined ? { step: i.step } : {}),
            ...(i.stop !== undefined ? { stop: i.stop } : {}),
            ...(i.custom_lists ? { customLists: i.custom_lists } : {}),
          })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: editor.wb.requireWorksheet(i.sheet).name, target: i.target }
      },
    },
    {
      name: 'drive.sheet_find_replace',
      module: DRIVE_MODULE_ID,
      summary:
        'Find or replace text in an Excel workbook (.xlsx) in Drive (supports Excel wildcards *, ?, ~, match_case, whole_cell, single sheet or whole workbook, look_in formulas or values). Omit `replace` to return matching cells without editing; provide `replace` (with optional `cells` subset) to replace and save a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof findReplaceInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to search or replace in file ${input.file_id} in Drive`
        if (input.replace === undefined) return `Searched ${name} in Drive`
        return `Replaced “${input.find}” in ${input.sheet ?? 'workbook'} of ${name} in Drive`
      },
      inputSchema: findReplaceInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = findReplaceInput.parse(input)
        if (i.replace !== undefined && i.look_in === 'values')
          throw new DriveError(
            'invalid',
            'Replace works on cell contents and formulas (`look_in: "formulas"`).',
          )
        const drive = await service()
        const lib = await xlsx()
        const eLib = await editingLib()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const hits = await guarded(lib, () =>
          eLib.find.findCells(
            editor,
            {
              query: i.find,
              sheet: i.sheet ?? null,
              matchCase: i.match_case ?? false,
              wholeCell: i.whole_cell ?? false,
              lookIn: i.look_in ?? 'formulas',
            },
            i.locale ?? 'en',
          ),
        )
        if (i.replace === undefined) {
          return {
            file: { id: file.id, name: file.name },
            revision: null,
            matches: hits,
            count: hits.length,
          }
        }
        const only = i.cells
          ? new Set(
              i.cells.map(
                (c) => `${c.sheet.toLowerCase()}!${c.ref.toUpperCase().replace(/\$/g, '')}`,
              ),
            )
          : null
        const targetHits = only
          ? hits.filter((h) => only.has(`${h.sheet.toLowerCase()}!${h.ref.toUpperCase()}`))
          : hits
        await guarded(lib, () => {
          editor.apply({
            op: 'replace',
            find: i.find,
            replace: i.replace!,
            sheet: i.sheet ?? null,
            matchCase: i.match_case ?? false,
            wholeCell: i.whole_cell ?? false,
            ...(i.cells ? { cells: i.cells } : {}),
          })
        })
        if (!editor.changed()) {
          return {
            file: { id: file.id, name: file.name },
            revision: null,
            replaced: 0,
            matches: [],
          }
        }
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, replaced: targetHits.length, matches: targetHits }
      },
    },
    {
      name: 'drive.sheet_merge',
      module: DRIVE_MODULE_ID,
      summary:
        'Merge or unmerge cells (`mode`: center | merge | across | unmerge), clear cells (`clear`: all | contents | formats), shift numeric decimals (`shift_decimals`: 1 | -1), or set inline rich-text runs (`rich_text`: { ref, runs }) in an Excel workbook (.xlsx) in Drive. Refuses lossy merges unless `accept_losses: true`. Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof mergeInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to edit cells in file ${input.file_id} in Drive`
        const parts: string[] = []
        if (input.mode && input.range) parts.push(`${input.mode} ${input.range}`)
        if (input.clear && input.range) parts.push(`clear ${input.clear} ${input.range}`)
        if (input.shift_decimals && input.range) parts.push(`shift decimals ${input.range}`)
        if (input.rich_text) parts.push(`rich text ${input.rich_text.ref}`)
        return `Updated ${parts.join(', ') || input.sheet} in ${name} in Drive`
      },
      inputSchema: mergeInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = mergeInput.parse(input)
        if (!i.mode && !i.clear && i.shift_decimals === undefined && !i.rich_text)
          throw new DriveError('invalid', 'Give mode, clear, shift_decimals, or rich_text.')
        if ((i.mode || i.clear || i.shift_decimals !== undefined) && !i.range)
          throw new DriveError('invalid', 'Give `range` when using mode, clear, or shift_decimals.')
        const ops: SheetOp[] = []
        if (i.mode && i.range)
          ops.push({ op: 'merge_cells', sheet: i.sheet, range: i.range, mode: i.mode })
        if (i.clear && i.range)
          ops.push({ op: 'clear_range', sheet: i.sheet, range: i.range, what: i.clear })
        if (i.shift_decimals !== undefined && i.range)
          ops.push({
            op: 'shift_decimals',
            sheet: i.sheet,
            range: i.range,
            delta: i.shift_decimals,
          })
        if (i.rich_text)
          ops.push({
            op: 'set_rich_text',
            sheet: i.sheet,
            ref: i.rich_text.ref,
            runs: i.rich_text.runs,
          })
        const drive = await service()
        const lib = await xlsx()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const warnings: string[] = []
        await guarded(lib, () => {
          const batchOp: SheetOp = ops.length === 1 ? ops[0]! : { op: 'batch', ops }
          const losses = editor.losses(batchOp)
          if (losses.length > 0 && !i.accept_losses) throw new lib.ops.XlsxLossError(losses)
          warnings.push(...losses.map(lib.ops.describeLoss))
          editor.apply(batchOp, { acceptLosses: true })
        })
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        return { ...saved, sheet: editor.wb.requireWorksheet(i.sheet).name, warnings }
      },
    },
    {
      name: 'drive.sheet_rows_cols',
      module: DRIVE_MODULE_ID,
      summary:
        'Hide/unhide rows and columns, group/ungroup outline bands, collapse/expand groups, switch outline level, or autofit column widths and row heights in an Excel workbook (.xlsx) in Drive. Saved as one new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof rowsColsInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Adjusted rows/columns (${plural(input.changes.length, 'change')}) in ${input.sheet} of ${name} in Drive`
          : `Tried to adjust rows/columns in file ${input.file_id} in Drive`
      },
      inputSchema: rowsColsInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = rowsColsInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const eLib = await editingLib()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          const ops = i.changes.map((c) => rowColToOp(lib, i.sheet, c))
          editor.apply(ops.length === 1 ? ops[0]! : { op: 'batch', ops })
        })
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        const outline = await guarded(lib, () => eLib.rowsCols.outlineOf(editor.wb, i.sheet))
        return { ...saved, sheet: editor.wb.requireWorksheet(i.sheet).name, outline }
      },
    },
    {
      name: 'drive.sheet_tab',
      module: DRIVE_MODULE_ID,
      summary:
        'Manage sheet tabs and per-sheet view/print settings in an Excel workbook (.xlsx) in Drive: move_sheet (reorder tab to 1-based position), set_sheet_color (#RRGGBB or null), set_sheet_visibility (visible | hidden | veryHidden), duplicate_sheet, set_view_options (gridlines, headings, zoom), and set_page_setup (orientation, paper size, scale, fit to page, margins, print area, repeat rows/cols). Saved as a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof tabInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Updated sheet ${input.sheet} (${input.action}) in ${name} in Drive`
          : `Tried to update sheet tab in file ${input.file_id} in Drive`
      },
      inputSchema: tabInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = tabInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const warnings: string[] = []
        let acceptLosses = false
        let op: SheetOp
        switch (i.action) {
          case 'move_sheet':
            op = { op: 'move_sheet', sheet: i.sheet, to: i.position - 1 }
            break
          case 'set_sheet_color':
            op = { op: 'set_sheet_color', sheet: i.sheet, color: i.color }
            break
          case 'set_sheet_visibility':
            op = { op: 'set_sheet_visibility', sheet: i.sheet, state: i.state }
            break
          case 'duplicate_sheet':
            acceptLosses = i.accept_losses ?? false
            op = {
              op: 'duplicate_sheet',
              sheet: i.sheet,
              ...(i.name !== undefined ? { name: i.name } : {}),
              ...(i.position !== undefined ? { to: i.position - 1 } : {}),
            }
            break
          case 'set_view_options':
            op = {
              op: 'set_view_options',
              sheet: i.sheet,
              ...(i.show_gridlines !== undefined ? { showGridlines: i.show_gridlines } : {}),
              ...(i.show_headings !== undefined ? { showHeadings: i.show_headings } : {}),
              ...(i.zoom_scale !== undefined ? { zoomScale: i.zoom_scale } : {}),
            }
            break
          case 'set_page_setup':
            op = {
              op: 'set_page_setup',
              sheet: i.sheet,
              ...(i.orientation !== undefined ? { orientation: i.orientation } : {}),
              ...(i.paper_size !== undefined ? { paperSize: i.paper_size } : {}),
              ...(i.scale !== undefined ? { scale: i.scale } : {}),
              ...(i.fit_to_width !== undefined ? { fitToWidth: i.fit_to_width } : {}),
              ...(i.fit_to_height !== undefined ? { fitToHeight: i.fit_to_height } : {}),
              ...(i.margins !== undefined ? { margins: i.margins } : {}),
              ...(i.print_gridlines !== undefined ? { printGridlines: i.print_gridlines } : {}),
              ...(i.print_headings !== undefined ? { printHeadings: i.print_headings } : {}),
              ...(i.center_horizontally !== undefined
                ? { centerHorizontally: i.center_horizontally }
                : {}),
              ...(i.center_vertically !== undefined
                ? { centerVertically: i.center_vertically }
                : {}),
              ...(i.print_area !== undefined ? { printArea: i.print_area } : {}),
              ...(i.repeat_rows !== undefined ? { repeatRows: i.repeat_rows } : {}),
              ...(i.repeat_cols !== undefined ? { repeatCols: i.repeat_cols } : {}),
            }
            break
        }
        await guarded(lib, () => {
          const losses = editor.losses(op)
          if (losses.length > 0 && !acceptLosses) throw new lib.ops.XlsxLossError(losses)
          warnings.push(...losses.map(lib.ops.describeLoss))
          editor.apply(op, { acceptLosses: true })
        })
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        return { ...saved, sheets: lib.read.sheetSummaries(editor), warnings }
      },
    },
    {
      name: 'drive.sheet_export_pdf',
      module: DRIVE_MODULE_ID,
      summary:
        'Render an Excel workbook (.xlsx) or one sheet of it in Drive to a paginated PDF using its page setup (orientation, paper size, fit to width, margins, print area, repeat titles, gridlines, headings). Returns { filename, mime, sizeBytes, sheets, dataB64 }. Saves nothing.',
      auditClass: 'read',
      inputSchema: exportPdfInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = exportPdfInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { exportWorkbookPdf, PdfBrowserUnavailableError } =
          await import('$lib/office/xlsx/print-pdf')
        const { file, editor } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const hasOverride =
          i.orientation !== undefined ||
          i.paper_size !== undefined ||
          i.fit_to_width !== undefined ||
          i.print_gridlines !== undefined ||
          i.print_headings !== undefined
        if (hasOverride) {
          await guarded(lib, () => {
            const targets = i.sheet
              ? [editor.wb.requireWorksheet(i.sheet).name]
              : editor.wb
                  .sheets()
                  .filter((s) => s.kind === 'worksheet' && s.state === 'visible')
                  .map((s) => s.name)
            for (const sName of targets) {
              editor.apply({
                op: 'set_page_setup',
                sheet: sName,
                ...(i.orientation !== undefined ? { orientation: i.orientation } : {}),
                ...(i.paper_size !== undefined ? { paperSize: i.paper_size } : {}),
                ...(i.fit_to_width !== undefined ? { fitToWidth: i.fit_to_width } : {}),
                ...(i.print_gridlines !== undefined ? { printGridlines: i.print_gridlines } : {}),
                ...(i.print_headings !== undefined ? { printHeadings: i.print_headings } : {}),
              })
            }
          })
        }
        try {
          const out = await guarded(lib, () =>
            exportWorkbookPdf(
              editor,
              file.name,
              { ...(i.sheet ? { sheet: i.sheet } : {}), ...(i.locale ? { locale: i.locale } : {}) },
              pdfDeps,
            ),
          )
          return {
            filename: out.filename,
            mime: out.mime,
            sizeBytes: out.sizeBytes,
            sheets: out.sheets,
            dataB64: Buffer.from(out.bytes).toString('base64'),
          }
        } catch (err) {
          if (err instanceof PdfBrowserUnavailableError)
            throw new DriveError('unavailable', err.message, undefined, { cause: err })
          throw err
        }
      },
    },
  ]
}
