import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { SheetOp } from '$lib/office/xlsx/ops'
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
} from './sheet-tools'

/**
 * drive.sheet_sort, drive.sheet_filter, drive.sheet_freeze — the grid's
 * Sort, Filter and Freeze panes as registry actions (src/lib/office/xlsx/
 * sort.ts, filter.ts, panes.ts), saved like the other drive.sheet_* writes:
 * a new revision of the same file, refused while someone has it open for
 * editing or when it changed between reading and saving. What a sheet's
 * filter and frozen panes are is in drive.sheet_read's sheet list.
 */

/** Filter and pane reading load with the workbook, not with the registry. */
const arrangeLib = async () => {
  const [filter, panes] = await Promise.all([
    import('$lib/office/xlsx/filter'),
    import('$lib/office/xlsx/panes'),
  ])
  return { filter, panes }
}

const rangeText = z.string().min(2).max(30)

const sortInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    range: rangeText.describe('The cells to sort, like A1:D20 (whole rows of it move)'),
    header: z
      .boolean()
      .optional()
      .describe('The range’s first row is a header and stays on top (default false)'),
    by: z
      .array(
        z
          .object({
            column: column.describe('A column of the range (letter or number from 1)'),
            descending: z.boolean().optional(),
          })
          .strict(),
      )
      .min(1)
      .max(64)
      .describe('Sort keys in order: the first decides, the next breaks ties'),
    accept_losses: z
      .boolean()
      .optional()
      .describe(
        'Sort even when comments, pictures or tables in the range would stay where they are (the refusal names them)',
      ),
  })
  .strict()

const filterInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    table: z
      .string()
      .min(1)
      .max(255)
      .optional()
      .describe(
        'Filter this Excel table’s columns instead of the sheet’s AutoFilter (its drop-downs are on with drive.sheet_table_update auto_filter)',
      ),
    off: z.literal(true).optional().describe('Turn the sheet’s filter off (every row shows again)'),
    range: rangeText
      .optional()
      .describe(
        'Turn the filter on for this range (its first row holds the drop-downs); a single cell takes the block of filled cells around it',
      ),
    columns: z
      .array(
        z
          .object({
            column,
            values: z
              .array(z.string().max(255))
              .max(10_000)
              .nullable()
              .describe(
                'The shown texts to keep (as drive.sheet_read shows them, any case); null clears the column’s filter',
              ),
            blanks: z.boolean().optional().describe('Keep empty cells too'),
          })
          .strict(),
      )
      .max(100)
      .optional()
      .describe('Filter columns by values; rows that don’t match are hidden as in Excel'),
  })
  .strict()

const freezeInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    rows: z
      .number()
      .int()
      .min(0)
      .max(1000)
      .describe('Rows from the top that stay in place (1 = the top row, 0 = none)'),
    columns: z
      .number()
      .int()
      .min(0)
      .max(100)
      .describe('Columns from the left that stay in place (0 = none); rows and columns 0 unfreeze'),
  })
  .strict()

export function createDriveSheetArrangeTools({ service, sheetLive }: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_sort',
      module: DRIVE_MODULE_ID,
      summary:
        'Sort a range of an Excel workbook (.xlsx) in Drive like Excel’s Data ▸ Sort (file_id, sheet, range, header, by: [{ column, descending }]): each row’s cells move whole (values, formats, formulas; relative references in moved formulas follow, absolute ones stay). Excel’s order: numbers, text (ignoring case), FALSE/TRUE, errors; blanks always last. Hidden rows stay where they are. Merged cells or array formulas in the range are refused. When comments, pictures or tables in the range would stay behind the call is refused and names them; accept_losses: true sorts anyway. Saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof sortInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Sorted ${input.range} in ${input.sheet} of ${name} in Drive`
          : `Tried to sort cells in file ${input.file_id} in Drive`
      },
      inputSchema: sortInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = sortInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const warnings: string[] = []
        await guarded(lib, () => {
          const op: SheetOp = {
            op: 'sort_range',
            sheet: i.sheet,
            range: i.range,
            header: i.header ?? false,
            keys: i.by.map((k) => ({
              col: colIndex(lib, k.column),
              descending: k.descending ?? false,
            })),
          }
          const losses = editor.losses(op)
          if (losses.length > 0 && !i.accept_losses) throw new lib.ops.XlsxLossError(losses)
          warnings.push(...losses.map(lib.ops.describeLoss))
          editor.apply(op, { acceptLosses: true })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, warnings }
      },
    },
    {
      name: 'drive.sheet_filter',
      module: DRIVE_MODULE_ID,
      summary:
        'Filter a sheet of an Excel workbook (.xlsx) in Drive like Excel’s AutoFilter (file_id, sheet; range: turn the filter on for a range, its first row holds the drop-downs; columns: [{ column, values: shown texts to keep | null to clear, blanks }]; off: true turns it off and shows every row). Rows that don’t match are hidden as in Excel; conditions set in Excel that this editor can’t evaluate are kept as they are. A sheet filter can’t overlap a table; tables filter themselves — give table: its name to filter that table’s columns. Answers with the filter and how many rows show. Saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof filterInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to filter a sheet of file ${input.file_id} in Drive`
        if (input.off) return `Turned the filter off in ${input.sheet} of ${name} in Drive`
        const n = input.columns?.length ?? 0
        return n > 0
          ? `Filtered ${plural(n, 'column')} in ${input.sheet} of ${name} in Drive`
          : `Turned the filter on in ${input.sheet} of ${name} in Drive`
      },
      inputSchema: filterInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = filterInput.parse(input)
        if (i.off && (i.range || i.columns?.length))
          throw new DriveError('invalid', 'Turn the filter off, or set it: not both at once.')
        if (i.table && (i.off || i.range))
          throw new DriveError(
            'invalid',
            'A table’s filter is turned on and off with drive.sheet_table_update (auto_filter); give only columns here.',
          )
        if (!i.off && !i.range && !i.columns?.length)
          throw new DriveError('invalid', 'Nothing to do: give a range, columns, or off: true.')
        const drive = await service()
        const lib = await xlsx()
        const { file, editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          if (i.off) editor.apply({ op: 'set_autofilter', sheet: i.sheet, range: null })
          else if (i.range) editor.apply({ op: 'set_autofilter', sheet: i.sheet, range: i.range })
          for (const c of i.columns ?? [])
            editor.apply({
              op: 'filter_column',
              sheet: i.sheet,
              col: colIndex(lib, c.column),
              values: c.values,
              blanks: c.blanks ?? false,
              ...(i.table ? { table: i.table } : {}),
            })
        })
        const saved = editor.changed()
          ? await save(drive, ctx, i.file_id, editor, base)
          : { file: { id: file.id, name: file.name }, revision: null }
        const { filter: f } = await arrangeLib()
        const filter = await guarded(lib, () => {
          const af = i.table
            ? (f
                .sheetFilters(editor.wb, i.sheet)
                .find((x) => x.table?.toLowerCase() === i.table!.toLowerCase()) ?? null)
            : f.autoFilterOf(editor.wb, i.sheet)
          if (!af) return null
          const rows = editor.wb.sheet(i.sheet).rows
          let hidden = 0
          for (let r = af.range.top + 1; r <= af.range.bottom; r++)
            if (rows.get(r)?.hidden) hidden++
          return {
            ...f.describeAutoFilter(af),
            rows_shown: af.range.bottom - af.range.top - hidden,
            rows_hidden: hidden,
          }
        })
        return { ...saved, filter }
      },
    },
    {
      name: 'drive.sheet_freeze',
      module: DRIVE_MODULE_ID,
      summary:
        'Freeze panes of a sheet in an Excel workbook (.xlsx) in Drive (file_id, sheet, rows, columns): that many rows from the top and columns from the left stay in place while the rest scrolls, as Excel’s View ▸ Freeze Panes writes it (rows 1, columns 0 = the top row; both 0 unfreezes). Saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof freezeInput>, output: unknown) => {
        const name = nameOf(output)
        if (!name) return `Tried to freeze panes in file ${input.file_id} in Drive`
        if (!input.rows && !input.columns)
          return `Unfroze the panes of ${input.sheet} in ${name} in Drive`
        const what = [
          input.rows ? plural(input.rows, 'row') : '',
          input.columns ? plural(input.columns, 'column') : '',
        ]
          .filter(Boolean)
          .join(' and ')
        return `Froze ${what} of ${input.sheet} in ${name} in Drive`
      },
      inputSchema: freezeInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = freezeInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () =>
          editor.apply({ op: 'freeze_panes', sheet: i.sheet, rows: i.rows, cols: i.columns }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const { panes } = await arrangeLib()
        const frozen = panes.frozenOf(editor.wb, i.sheet)
        return { ...saved, frozen: frozen ? { rows: frozen.rows, columns: frozen.cols } : null }
      },
    },
  ]
}
