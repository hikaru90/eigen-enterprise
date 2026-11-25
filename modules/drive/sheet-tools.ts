import type { DriveService, ItemView } from './service'
import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { SheetEditor } from '$lib/office/xlsx/editor'
import type { SheetOp } from '$lib/office/xlsx/ops'
import { DRIVE_MODULE_ID } from './manifest'
import { officeKind } from './preview'
import { DriveError } from './service'
import { actorOf } from './tools'

/**
 * drive.sheet_* — the Drive's spreadsheet editor as registry actions: read
 * an Excel workbook's sheets and cells (values calculated, formulas, shown
 * text, formats), write cells and number formats, and change its structure
 * (add, rename, delete sheets; insert and delete rows and columns). The same
 * operations the grid makes (src/lib/office/xlsx/ops.ts), saved the same way:
 * a new revision of the same file through the Drive service as the caller,
 * refused while someone has it open for editing, and refused — never
 * overwritten — when the file changed between reading and saving.
 *
 * Moving cells moves formulas, names, merges, links, conditional formats and
 * validations with them. What would be left in the wrong place (tables,
 * pivot tables, pictures, charts, comments) is named, and the change runs
 * only with accept_losses: true.
 */

export type DriveSheetToolDeps = { service: () => Promise<DriveService> }

export const DRIVE_ROLES = ['admin', 'member', 'agent']
/** One call reads or writes at most this many cells: more is refused (ask for a smaller range), never cut. */
export const SHEET_MAX_CELLS = 5000

export const fileId = z.string().min(1)
export const sheetName = z.string().min(1).max(31).describe('The sheet (tab) name')
const cellRef = z.string().min(2).max(10).describe('A cell address like B3')
const cellValue = z.union([z.string(), z.number(), z.boolean(), z.null()])

const readInput = z
  .object({
    file_id: fileId,
    sheet: sheetName.optional().describe('The sheet to read; omitted: the first visible sheet'),
    range: z
      .string()
      .min(2)
      .max(30)
      .optional()
      .describe('Like A1:D20; omitted: the sheet’s used range'),
  })
  .strict()

const writeInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    cells: z
      .array(
        z
          .object({
            ref: cellRef,
            value: cellValue
              .optional()
              .describe(
                'A number, text or true/false; null or "" clears the content (the format stays)',
              ),
            formula: z
              .string()
              .min(1)
              .max(8000)
              .optional()
              .describe('A formula in Excel’s English syntax, e.g. =SUM(B2:B9) or =Sheet2!A1*2'),
            format: z
              .string()
              .min(1)
              .max(255)
              .optional()
              .describe('A number format code, e.g. #,##0.00, 0%, yyyy-mm-dd, @ for text'),
          })
          .strict(),
      )
      .max(SHEET_MAX_CELLS)
      .optional(),
    formats: z
      .array(
        z.object({ range: z.string().min(2).max(30), format: z.string().min(1).max(255) }).strict(),
      )
      .max(100)
      .optional()
      .describe(
        'Number formats for whole ranges (e.g. { range: "B2:B40", format: "#,##0.00 [$€-407]" })',
      ),
  })
  .strict()

export const column = z
  .union([z.number().int().min(1), z.string().regex(/^[A-Za-z]{1,3}$/)])
  .describe('A column letter (C) or number from 1')
const structureChange = z.discriminatedUnion('action', [
  z.object({ action: z.literal('add_sheet'), name: sheetName }).strict(),
  z.object({ action: z.literal('rename_sheet'), sheet: sheetName, name: sheetName }).strict(),
  z.object({ action: z.literal('delete_sheet'), sheet: sheetName }).strict(),
  z
    .object({
      action: z.literal('insert_rows'),
      sheet: sheetName,
      at: z.number().int().min(1).describe('The new rows start at this row number (1 = top)'),
      count: z.number().int().min(1).max(10_000).default(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('delete_rows'),
      sheet: sheetName,
      at: z.number().int().min(1).describe('The first row to delete'),
      count: z.number().int().min(1).max(10_000).default(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('insert_columns'),
      sheet: sheetName,
      at: column,
      count: z.number().int().min(1).max(1000).default(1),
    })
    .strict(),
  z
    .object({
      action: z.literal('delete_columns'),
      sheet: sheetName,
      at: column,
      count: z.number().int().min(1).max(1000).default(1),
    })
    .strict(),
])
const structureInput = z
  .object({
    file_id: fileId,
    changes: z
      .array(structureChange)
      .min(1)
      .max(50)
      .describe('Applied in order, saved as one revision'),
    accept_losses: z
      .boolean()
      .optional()
      .describe(
        'Do it even when tables, pivot tables, pictures, charts or comments would be left in the wrong place (the refusal names them)',
      ),
  })
  .strict()

export type Xlsx = {
  opc: typeof import('$lib/office/ooxml/package')
  editor: typeof import('$lib/office/xlsx/editor')
  ops: typeof import('$lib/office/xlsx/ops')
  read: typeof import('$lib/office/xlsx/read')
  ref: typeof import('$lib/office/xlsx/ref')
  workbook: typeof import('$lib/office/xlsx/workbook')
}
/** The spreadsheet code loads when a workbook is used, not with the registry. */
export async function xlsx(): Promise<Xlsx> {
  const [opc, editor, ops, read, ref, workbook] = await Promise.all([
    import('$lib/office/ooxml/package'),
    import('$lib/office/xlsx/editor'),
    import('$lib/office/xlsx/ops'),
    import('$lib/office/xlsx/read'),
    import('$lib/office/xlsx/ref'),
    import('$lib/office/xlsx/workbook'),
  ])
  return { opc, editor, ops, read, ref, workbook }
}

/** A workbook refusal (no such sheet, a formula that can't be read, losses not accepted) is the caller's to fix. */
export async function guarded<T>(lib: Xlsx, work: () => T | Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (err) {
    if (err instanceof lib.workbook.XlsxError || err instanceof lib.ref.XlsxRefError)
      throw new DriveError('invalid', err.message, undefined, { cause: err })
    if (err instanceof lib.opc.OpcError)
      throw new DriveError('invalid', `The workbook could not be read: ${err.message}`, undefined, {
        cause: err,
      })
    throw err
  }
}

export async function openBook(drive: DriveService, ctx: ToolContext, id: string, lib: Xlsx) {
  const { file, bytes } = await drive.readFile(actorOf(ctx), id)
  if (officeKind(file.name, file.mime) !== 'xlsx')
    throw new DriveError('invalid', `“${file.name}” is not an Excel workbook (.xlsx).`)
  const editor = await guarded(lib, () => lib.editor.createSheetEditor(bytes))
  return { file, editor, base: createHash('sha256').update(bytes).digest('hex') }
}

type Saved = { file: ItemView; revision: { id: string; createdAt: Date } }

export async function save(
  drive: DriveService,
  ctx: ToolContext,
  id: string,
  editor: SheetEditor,
  base: string,
): Promise<Saved> {
  const out = await drive.writeBytes(actorOf(ctx), id, editor.toBytes(), undefined, {
    baseSha256: base,
  })
  return { file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
}

export const colIndex = (lib: Xlsx, at: number | string) => {
  if (typeof at === 'number') return at - 1
  const i = lib.ref.colIndex(at)
  if (i === null) throw new DriveError('invalid', `“${at}” is not a column.`)
  return i
}

function toOp(lib: Xlsx, c: z.infer<typeof structureChange>): SheetOp {
  switch (c.action) {
    case 'add_sheet':
      return { op: 'add_sheet', name: c.name }
    case 'rename_sheet':
      return { op: 'rename_sheet', sheet: c.sheet, name: c.name }
    case 'delete_sheet':
      return { op: 'delete_sheet', sheet: c.sheet }
    case 'insert_rows':
    case 'delete_rows':
      return { op: c.action, sheet: c.sheet, at: c.at - 1, count: c.count }
    case 'insert_columns':
    case 'delete_columns':
      return { op: c.action, sheet: c.sheet, at: colIndex(lib, c.at), count: c.count }
  }
}

export const nameOf = (output: unknown) => (output as { file?: { name?: string } } | undefined)?.file?.name
export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

function describeChange(c: z.infer<typeof structureChange>): string {
  switch (c.action) {
    case 'add_sheet':
      return `added the sheet ${c.name}`
    case 'rename_sheet':
      return `renamed ${c.sheet} to ${c.name}`
    case 'delete_sheet':
      return `deleted the sheet ${c.sheet}`
    case 'insert_rows':
      return `inserted ${plural(c.count, 'row')} in ${c.sheet}`
    case 'delete_rows':
      return `deleted ${plural(c.count, 'row')} in ${c.sheet}`
    case 'insert_columns':
      return `inserted ${plural(c.count, 'column')} in ${c.sheet}`
    case 'delete_columns':
      return `deleted ${plural(c.count, 'column')} in ${c.sheet}`
  }
}

export function createDriveSheetTools({ service }: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_read',
      module: DRIVE_MODULE_ID,
      summary: `Read an Excel workbook (.xlsx) in Drive: its sheets (name, used range, hidden, the AutoFilter and its filtered columns, frozen panes), and the filled cells of one sheet's range (default: the first visible sheet, its used range) with each cell's value (formulas calculated), formula, shown text and number format. At most ${SHEET_MAX_CELLS} cells per call; ask for a smaller range for more. A value marked "kept" is Excel's last result for a formula this editor can't calculate.`,
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: readInput,
      handler: async (ctx, input) => {
        const i = readInput.parse(input)
        const lib = await xlsx()
        const { file, editor } = await openBook(await service(), ctx, i.file_id, lib)
        return guarded(lib, () => {
          const sheets = lib.read.sheetSummaries(editor)
          const sheet =
            i.sheet ??
            editor.wb.sheets().find((s) => s.kind === 'worksheet' && s.state === 'visible')?.name
          if (!sheet)
            return {
              file: { id: file.id, name: file.name },
              sheets,
              sheet: null,
              range: null,
              cells: [],
            }
          const { range, cells } = lib.read.readCells(
            editor,
            sheet,
            i.range ?? null,
            'en',
            SHEET_MAX_CELLS,
          )
          return {
            file: { id: file.id, name: file.name },
            sheets,
            sheet: editor.wb.requireWorksheet(sheet).name,
            range,
            cells,
          }
        })
      },
    },
    {
      name: 'drive.sheet_write',
      module: DRIVE_MODULE_ID,
      summary: `Write cells of an Excel workbook (.xlsx) in Drive (file_id, sheet; cells: [{ ref: "B3", value | formula | format }], formats: [{ range, format }]): numbers, text, true/false, formulas in Excel's English syntax (=SUM(B2:B9)), number formats (#,##0.00, 0%, yyyy-mm-dd). null clears a cell's content. Cell formats, other cells and sheets stay as they are. Saved as a new revision that can be restored; the result shows the written cells as calculated. At most ${SHEET_MAX_CELLS} cells.`,
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof writeInput>, output: unknown) => {
        const name = nameOf(output)
        const n = (input.cells?.length ?? 0) + (input.formats?.length ?? 0)
        return name
          ? `Wrote ${plural(n, 'cell')} in ${input.sheet} of ${name} in Drive`
          : `Tried to write cells in file ${input.file_id} in Drive`
      },
      inputSchema: writeInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = writeInput.parse(input)
        if (!i.cells?.length && !i.formats?.length)
          throw new DriveError('invalid', 'Nothing to write: give cells or formats.')
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        await guarded(lib, () => {
          if (i.cells?.length) editor.apply({ op: 'set_cells', sheet: i.sheet, cells: i.cells })
          for (const f of i.formats ?? [])
            editor.apply({ op: 'set_format', sheet: i.sheet, range: f.range, format: f.format })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const written = new Set((i.cells ?? []).map((c) => c.ref.toUpperCase().replace(/\$/g, '')))
        const { cells } = await guarded(lib, () =>
          lib.read.readCells(editor, i.sheet, null, 'en', Number.MAX_SAFE_INTEGER),
        )
        return { ...saved, cells: cells.filter((c) => written.has(c.ref)) }
      },
    },
    {
      name: 'drive.sheet_structure',
      module: DRIVE_MODULE_ID,
      summary:
        'Change the structure of an Excel workbook (.xlsx) in Drive (file_id; changes in order: add_sheet { name }, rename_sheet { sheet, name }, delete_sheet { sheet }, insert_rows / delete_rows { sheet, at: row number, count }, insert_columns / delete_columns { sheet, at: column letter or number, count }). Formulas, names, merges, links and conditional formats follow moved cells; formulas that read a deleted sheet or deleted cells show #REF! as in Excel. When tables, pivot tables, pictures, charts or comments would be left in the wrong place the call is refused and names them; accept_losses: true does it anyway. Saved as one new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof structureInput>, output: unknown) => {
        const name = nameOf(output)
        const what = input.changes.map(describeChange).join(', ')
        return name
          ? `Changed ${name} in Drive: ${what}`
          : `Tried to change the sheets of file ${input.file_id} in Drive`
      },
      inputSchema: structureInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = structureInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib)
        const accepted: string[] = []
        await guarded(lib, () => {
          for (const c of i.changes) {
            const op = toOp(lib, c)
            const losses = editor.losses(op)
            if (losses.length > 0 && !i.accept_losses) throw new lib.ops.XlsxLossError(losses)
            accepted.push(...losses.map(lib.ops.describeLoss))
            editor.apply(op, { acceptLosses: true })
          }
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheets: lib.read.sheetSummaries(editor), warnings: accepted }
      },
    },
  ]
}
