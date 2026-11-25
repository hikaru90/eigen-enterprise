import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { DRIVE_MODULE_ID } from './manifest'
import {
  DRIVE_ROLES,
  fileId,
  guarded,
  nameOf,
  openBook,
  save,
  sheetName,
  xlsx,
  type DriveSheetToolDeps,
} from './sheet-tools'

/**
 * drive.sheet_table_* and drive.sheet_pivot_* — Excel tables and PivotTables
 * as kernel registry actions, matching the spreadsheet editor's operations
 * (src/lib/office/xlsx/tables.ts, pivot.ts). Every mutation opens, checks,
 * applies in one transaction, and saves a new Drive revision cleanly.
 */

const pivotTableLib = async () => {
  const [tables, pivot] = await Promise.all([
    import('$lib/office/xlsx/tables'),
    import('$lib/office/xlsx/pivot'),
  ])
  return { tables, pivot }
}

const tableName = z.string().min(1).max(255)
const pivotName = z.string().min(1).max(255)
const rangeText = z.string().min(2).max(60)
const pivotAgg = z.enum([
  'sum',
  'count',
  'average',
  'min',
  'max',
  'product',
  'countNums',
  'stdDev',
  'var',
])
const totalsFn = z.enum([
  'none',
  'sum',
  'count',
  'average',
  'min',
  'max',
  'countNums',
  'stdDev',
  'var',
  'custom',
])

const tableCreateInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    range: rangeText.describe('Range like A1:D10 (or a single cell to expand its current region)'),
    name: tableName.optional().describe('Table name (e.g. Orders; omitted: Table1, Table2, …)'),
    has_headers: z
      .boolean()
      .optional()
      .describe('Whether the first row holds column headers (default true; false shifts data down for headers)'),
    style: z.string().min(1).max(64).optional().describe('Built-in style like TableStyleMedium2'),
    auto_filter: z.boolean().optional().describe('Include AutoFilter drop-downs (default true)'),
  })
  .strict()

const tableUpdateInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    table: tableName.describe('Current name of the table'),
    name: tableName.optional().describe('Rename the table (structured refs follow)'),
    ref: rangeText.optional().describe('Resize table range, e.g. A1:E12'),
    header_row: z.boolean().optional(),
    totals_row: z.boolean().optional(),
    totals_columns: z
      .array(
        z
          .object({
            column: z.union([z.string().min(1).max(255), z.number().int().min(0)]),
            function: totalsFn,
            label: z.string().max(255).optional(),
            formula: z.string().max(4000).optional(),
          })
          .strict(),
      )
      .max(256)
      .optional(),
    style: z.string().min(1).max(64).optional(),
    show_first_column: z.boolean().optional(),
    show_last_column: z.boolean().optional(),
    show_row_stripes: z.boolean().optional(),
    show_column_stripes: z.boolean().optional(),
    auto_filter: z.boolean().optional(),
  })
  .strict()

const tableDeleteInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    table: tableName,
    mode: z
      .enum(['convert_to_range', 'delete_cells'])
      .optional()
      .describe('convert_to_range (default: keeps values & rewrites structured refs to A1) or delete_cells'),
  })
  .strict()

const pivotPageField = z
  .object({
    field: z.string().min(1).max(255),
    selected_item: z.string().max(255).optional(),
  })
  .strict()

const pivotDataField = z
  .object({
    field: z.string().min(1).max(255),
    agg: pivotAgg.optional(),
    name: z.string().min(1).max(255).optional(),
    num_fmt: z.string().min(1).max(128).optional(),
  })
  .strict()

const pivotCreateInput = z
  .object({
    file_id: fileId,
    source: z.string().min(1).max(128).describe('Source range (A1:D20, Sheet!A1:D20) or table name'),
    source_sheet: sheetName.optional(),
    target_sheet: sheetName.optional().describe('Omitted creates a new worksheet (PivotTable1, …)'),
    target_cell: z.string().min(2).max(16).optional().describe('Top-left anchor cell (default A3 on new sheet)'),
    name: pivotName.optional(),
    rows: z.array(z.string().min(1).max(255)).max(32).optional(),
    columns: z.array(z.string().min(1).max(255)).max(32).optional(),
    filters: z.array(pivotPageField).max(32).optional(),
    values: z.array(pivotDataField).max(32).optional(),
    row_grand_totals: z.boolean().optional(),
    col_grand_totals: z.boolean().optional(),
    subtotals: z.boolean().optional(),
    style: z.string().min(1).max(64).optional(),
  })
  .strict()

const pivotUpdateInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    pivot: pivotName,
    name: pivotName.optional(),
    rows: z.array(z.string().min(1).max(255)).max(32).optional(),
    columns: z.array(z.string().min(1).max(255)).max(32).optional(),
    filters: z.array(pivotPageField).max(32).optional(),
    values: z.array(pivotDataField).max(32).optional(),
    hidden_items: z.record(z.string(), z.array(z.string())).optional(),
    row_grand_totals: z.boolean().optional(),
    col_grand_totals: z.boolean().optional(),
    subtotals: z.boolean().optional(),
    style: z.string().min(1).max(64).optional(),
  })
  .strict()

const pivotRefreshInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    pivot: pivotName,
  })
  .strict()

const pivotDeleteInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    pivot: pivotName,
    keep_values: z.boolean().optional(),
  })
  .strict()

export function createDriveSheetPivotTableTools({
  service,
}: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_table_create',
      module: DRIVE_MODULE_ID,
      summary:
        'Create an Excel Table (ListObject) in an .xlsx sheet in Drive (like Ctrl+T): file_id, sheet, range (or single cell to expand current region), optional name, has_headers, style (TableStyleMedium2), auto_filter. Writes xl/tables/tableN.xml cleanly and saves a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof tableCreateInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Created a table on ${input.range} in ${input.sheet} of ${name} in Drive`
          : `Tried to create a table in file ${input.file_id} in Drive`
      },
      inputSchema: tableCreateInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = tableCreateInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { tables } = await pivotTableLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        await guarded(lib, () => {
          editor.apply({
            op: 'create_table',
            sheet: i.sheet,
            range: i.range,
            ...(i.name !== undefined ? { name: i.name } : {}),
            ...(i.has_headers !== undefined ? { hasHeaders: i.has_headers } : {}),
            ...(i.style !== undefined ? { style: i.style } : {}),
            ...(i.auto_filter !== undefined ? { autoFilter: i.auto_filter } : {}),
          })
        })
        const created = await guarded(lib, () => {
          const all = tables.readSheetTables(editor.wb, i.sheet)
          return i.name
            ? tables.tableSummary(tables.findTable(editor.wb, i.sheet, i.name))
            : tables.tableSummary(all.at(-1)!)
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, table: created }
      },
    },
    {
      name: 'drive.sheet_table_update',
      module: DRIVE_MODULE_ID,
      summary:
        'Update an Excel Table in an .xlsx sheet in Drive: rename, resize (ref), toggle header_row / totals_row (with SUBTOTAL), set per-column totals_columns, style, banded stripes, or auto_filter. Saves a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof tableUpdateInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Updated table ${input.table} in ${input.sheet} of ${name} in Drive`
          : `Tried to update a table in file ${input.file_id} in Drive`
      },
      inputSchema: tableUpdateInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = tableUpdateInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { tables } = await pivotTableLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        await guarded(lib, () => {
          editor.apply({
            op: 'update_table',
            sheet: i.sheet,
            table: i.table,
            ...(i.name !== undefined ? { name: i.name } : {}),
            ...(i.ref !== undefined ? { ref: i.ref } : {}),
            ...(i.header_row !== undefined ? { headerRow: i.header_row } : {}),
            ...(i.totals_row !== undefined ? { totalsRow: i.totals_row } : {}),
            ...(i.totals_columns !== undefined ? { totalsColumns: i.totals_columns } : {}),
            ...(i.style !== undefined ? { style: i.style } : {}),
            ...(i.show_first_column !== undefined ? { showFirstColumn: i.show_first_column } : {}),
            ...(i.show_last_column !== undefined ? { showLastColumn: i.show_last_column } : {}),
            ...(i.show_row_stripes !== undefined ? { showRowStripes: i.show_row_stripes } : {}),
            ...(i.show_column_stripes !== undefined ? { showColumnStripes: i.show_column_stripes } : {}),
            ...(i.auto_filter !== undefined ? { autoFilter: i.auto_filter } : {}),
          })
        })
        const updated = await guarded(lib, () =>
          tables.tableSummary(tables.findTable(editor.wb, i.sheet, i.name ?? i.table)),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, table: updated }
      },
    },
    {
      name: 'drive.sheet_table_delete',
      module: DRIVE_MODULE_ID,
      summary:
        'Convert an Excel Table back to a plain range (default: keeps values/styles and rewrites structured references to A1) or delete its cells (mode: "delete_cells"). Saves a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof tableDeleteInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Removed table ${input.table} from ${input.sheet} of ${name} in Drive`
          : `Tried to remove a table in file ${input.file_id} in Drive`
      },
      inputSchema: tableDeleteInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = tableDeleteInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        await guarded(lib, () => {
          editor.apply({
            op: 'delete_table',
            sheet: i.sheet,
            table: i.table,
            ...(i.mode !== undefined ? { mode: i.mode } : {}),
          })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, deleted: i.table, mode: i.mode ?? 'convert_to_range' }
      },
    },
    {
      name: 'drive.sheet_pivot_create',
      module: DRIVE_MODULE_ID,
      summary:
        'Create a PivotTable in an Excel workbook (.xlsx) in Drive from a range or table name: assigns row, column, page filter, and value aggregation fields, writes valid pivotCache and pivotTable XML parts + rendered grid cells, and saves a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof pivotCreateInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Created a PivotTable from ${input.source} in ${name} in Drive`
          : `Tried to create a PivotTable in file ${input.file_id} in Drive`
      },
      inputSchema: pivotCreateInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = pivotCreateInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { pivot } = await pivotTableLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        const res = await guarded(lib, () =>
          editor.apply({
            op: 'create_pivot',
            source: i.source,
            ...(i.source_sheet !== undefined ? { sourceSheet: i.source_sheet } : {}),
            ...(i.target_sheet !== undefined ? { targetSheet: i.target_sheet } : {}),
            ...(i.target_cell !== undefined ? { targetCell: i.target_cell } : {}),
            ...(i.name !== undefined ? { name: i.name } : {}),
            ...(i.rows !== undefined ? { rowFields: i.rows } : {}),
            ...(i.columns !== undefined ? { colFields: i.columns } : {}),
            ...(i.filters !== undefined
              ? {
                  pageFields: i.filters.map((f) => ({
                    field: f.field,
                    ...(f.selected_item !== undefined ? { selectedItem: f.selected_item } : {}),
                  })),
                }
              : {}),
            ...(i.values !== undefined
              ? {
                  dataFields: i.values.map((v) => ({
                    field: v.field,
                    ...(v.agg !== undefined ? { agg: v.agg } : {}),
                    ...(v.name !== undefined ? { name: v.name } : {}),
                    ...(v.num_fmt !== undefined ? { numFmt: v.num_fmt } : {}),
                  })),
                }
              : {}),
            ...(i.row_grand_totals !== undefined ? { rowGrandTotals: i.row_grand_totals } : {}),
            ...(i.col_grand_totals !== undefined ? { colGrandTotals: i.col_grand_totals } : {}),
            ...(i.subtotals !== undefined ? { subtotals: i.subtotals } : {}),
            ...(i.style !== undefined ? { style: i.style } : {}),
          }),
        )
        const targetSheet = res.focus ?? res.sheets[0]!
        const info = await guarded(lib, () => {
          const list = pivot.readSheetPivots(editor.wb, targetSheet)
          return pivot.pivotSummary(
            i.name ? pivot.findPivot(editor.wb, targetSheet, i.name) : list.at(-1)!,
          )
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: targetSheet, pivot: info }
      },
    },
    {
      name: 'drive.sheet_pivot_update',
      module: DRIVE_MODULE_ID,
      summary:
        'Update a PivotTable’s row/column/filter/value fields, item filters (hidden_items), grand totals, subtotals, name, or style in an Excel workbook (.xlsx) in Drive, recomputing cells and XML cache. Saves a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof pivotUpdateInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Updated PivotTable ${input.pivot} in ${input.sheet} of ${name} in Drive`
          : `Tried to update a PivotTable in file ${input.file_id} in Drive`
      },
      inputSchema: pivotUpdateInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = pivotUpdateInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { pivot } = await pivotTableLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        await guarded(lib, () => {
          editor.apply({
            op: 'update_pivot',
            sheet: i.sheet,
            pivot: i.pivot,
            ...(i.name !== undefined ? { name: i.name } : {}),
            ...(i.rows !== undefined ? { rowFields: i.rows } : {}),
            ...(i.columns !== undefined ? { colFields: i.columns } : {}),
            ...(i.filters !== undefined
              ? {
                  pageFields: i.filters.map((f) => ({
                    field: f.field,
                    ...(f.selected_item !== undefined ? { selectedItem: f.selected_item } : {}),
                  })),
                }
              : {}),
            ...(i.values !== undefined
              ? {
                  dataFields: i.values.map((v) => ({
                    field: v.field,
                    ...(v.agg !== undefined ? { agg: v.agg } : {}),
                    ...(v.name !== undefined ? { name: v.name } : {}),
                    ...(v.num_fmt !== undefined ? { numFmt: v.num_fmt } : {}),
                  })),
                }
              : {}),
            ...(i.hidden_items !== undefined ? { hiddenItems: i.hidden_items } : {}),
            ...(i.row_grand_totals !== undefined ? { rowGrandTotals: i.row_grand_totals } : {}),
            ...(i.col_grand_totals !== undefined ? { colGrandTotals: i.col_grand_totals } : {}),
            ...(i.subtotals !== undefined ? { subtotals: i.subtotals } : {}),
            ...(i.style !== undefined ? { style: i.style } : {}),
          })
        })
        const updated = await guarded(lib, () =>
          pivot.pivotSummary(pivot.findPivot(editor.wb, i.sheet, i.name ?? i.pivot)),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, pivot: updated }
      },
    },
    {
      name: 'drive.sheet_pivot_refresh',
      module: DRIVE_MODULE_ID,
      summary:
        'Refresh a PivotTable from its live source range or table in an Excel workbook (.xlsx) in Drive, rebuilding its pivot cache and rendered cells. Saves a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof pivotRefreshInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Refreshed PivotTable ${input.pivot} in ${input.sheet} of ${name} in Drive`
          : `Tried to refresh a PivotTable in file ${input.file_id} in Drive`
      },
      inputSchema: pivotRefreshInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = pivotRefreshInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { pivot } = await pivotTableLib()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        await guarded(lib, () => {
          editor.apply({ op: 'refresh_pivot', sheet: i.sheet, pivot: i.pivot })
        })
        const info = await guarded(lib, () =>
          pivot.pivotSummary(pivot.findPivot(editor.wb, i.sheet, i.pivot)),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, pivot: info }
      },
    },
    {
      name: 'drive.sheet_pivot_delete',
      module: DRIVE_MODULE_ID,
      summary:
        'Delete a PivotTable from an Excel workbook (.xlsx) in Drive, clearing its rendered cells (unless keep_values: true) and removing orphaned cache XML parts. Saves a new revision.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof pivotDeleteInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Deleted PivotTable ${input.pivot} from ${input.sheet} of ${name} in Drive`
          : `Tried to delete a PivotTable in file ${input.file_id} in Drive`
      },
      inputSchema: pivotDeleteInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = pivotDeleteInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        await guarded(lib, () => {
          editor.apply({
            op: 'delete_pivot',
            sheet: i.sheet,
            pivot: i.pivot,
            ...(i.keep_values !== undefined ? { keepValues: i.keep_values } : {}),
          })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, deleted: i.pivot, keep_values: i.keep_values ?? false }
      },
    },
  ]
}
