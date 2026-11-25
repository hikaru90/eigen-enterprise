import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { SheetOp } from '$lib/office/xlsx/ops'
import { BORDER_PRESETS, BORDER_STYLES, HORIZONTAL, VERTICAL } from '$lib/office/xlsx/style-choices'
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
 * drive.sheet_format — the spreadsheet editor's format toolbar and its
 * column/row drag handles as one registry action: fonts (bold, italic,
 * underline, strike, size, colour, family), fills, borders and alignment on
 * ranges, column widths and row heights. The same operations the grid makes
 * (src/lib/office/xlsx/format-cells.ts), saved the same way as the other
 * drive.sheet_* writes: one new revision, never over a newer version.
 */

const color = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .describe('A colour like #1F4E79')

const styleChange = z
  .object({
    range: z.string().min(2).max(30).describe('The cells, like B2:D9 or A1'),
    bold: z.boolean().optional(),
    italic: z.boolean().optional(),
    underline: z.boolean().optional(),
    strike: z.boolean().optional().describe('Strikethrough'),
    font_size: z.number().min(1).max(409).optional().describe('In points, e.g. 11'),
    font_color: color.nullable().optional().describe('Text colour; null: automatic'),
    font_name: z.string().min(1).max(31).optional().describe('A font family, e.g. Arial'),
    fill: color.nullable().optional().describe('Background colour; null: no fill'),
    horizontal: z.enum(HORIZONTAL).optional().describe('general: text left, numbers right'),
    vertical: z.enum(VERTICAL).optional(),
    wrap: z.boolean().optional().describe('Wrap text onto several lines'),
    border: z
      .object({
        preset: z
          .enum(BORDER_PRESETS)
          .describe(
            'all: every edge; outer: around the range; inner: the lines inside; top/bottom/left/right: that side of the range; none: remove the lines',
          ),
        style: z.enum(BORDER_STYLES).optional().describe('Line style (default thin)'),
        color: color.nullable().optional().describe('Line colour; null or left out: automatic'),
      })
      .strict()
      .optional(),
  })
  .strict()

const columnSize = z
  .object({
    from: column,
    to: column.optional().describe('The last column (default: just `from`)'),
    width: z
      .number()
      .gt(0)
      .max(255)
      .nullable()
      .describe('In Excel characters (8.43 is the default); null: back to the default'),
  })
  .strict()

const rowSize = z
  .object({
    from: z.number().int().min(1).describe('A row number (1 = top)'),
    to: z.number().int().min(1).optional().describe('The last row (default: just `from`)'),
    height: z
      .number()
      .gt(0)
      .max(409)
      .nullable()
      .describe('In points (15 is the default); null: back to the automatic height'),
  })
  .strict()

const formatInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    styles: z.array(styleChange).max(100).optional().describe('Applied in order'),
    columns: z.array(columnSize).max(100).optional(),
    rows: z.array(rowSize).max(100).optional(),
  })
  .strict()

type FormatInput = z.infer<typeof formatInput>

function toOps(lib: Xlsx, i: FormatInput): SheetOp[] {
  const ops: SheetOp[] = []
  for (const s of i.styles ?? []) {
    const style: Extract<SheetOp, { op: 'set_style' }>['style'] = {}
    if (s.bold !== undefined) style.bold = s.bold
    if (s.italic !== undefined) style.italic = s.italic
    if (s.underline !== undefined) style.underline = s.underline
    if (s.strike !== undefined) style.strike = s.strike
    if (s.font_size !== undefined) style.fontSize = s.font_size
    if (s.font_color !== undefined) style.fontColor = s.font_color
    if (s.font_name !== undefined) style.fontName = s.font_name
    if (s.fill !== undefined) style.fill = s.fill
    if (s.horizontal !== undefined) style.horizontal = s.horizontal
    if (s.vertical !== undefined) style.vertical = s.vertical
    if (s.wrap !== undefined) style.wrap = s.wrap
    if (s.border)
      style.border = {
        preset: s.border.preset,
        ...(s.border.style ? { style: s.border.style } : {}),
        ...(s.border.color !== undefined ? { color: s.border.color } : {}),
      }
    if (Object.keys(style).length === 0)
      throw new DriveError('invalid', `${s.range}: nothing to format (give at least one style).`)
    ops.push({ op: 'set_style', sheet: i.sheet, range: s.range, style })
  }
  for (const c of i.columns ?? []) {
    const from = colIndex(lib, c.from)
    const to = colIndex(lib, c.to ?? c.from)
    ops.push({ op: 'set_column_width', sheet: i.sheet, from, to, width: c.width })
  }
  for (const r of i.rows ?? [])
    ops.push({
      op: 'set_row_height',
      sheet: i.sheet,
      from: r.from - 1,
      to: (r.to ?? r.from) - 1,
      height: r.height,
    })
  return ops
}

export function createDriveSheetFormatTools({ service, sheetLive }: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_format',
      module: DRIVE_MODULE_ID,
      summary:
        'Format cells of an Excel workbook (.xlsx) in Drive (file_id, sheet): styles: [{ range, bold, italic, underline, strike, font_size, font_color, font_name, fill, horizontal, vertical, wrap, border: { preset: all | outer | inner | top | bottom | left | right | none, style, color } }] — only what you give changes, the rest of each cell’s look and its number format stay; columns: [{ from: "B", to: "D", width: characters | null }]; rows: [{ from: 2, to: 5, height: points | null }] (null: back to the default). Colours are #RRGGBB. Saved as one new revision that can be restored. drive.sheet_read shows the result (style per cell, sizes).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: FormatInput, output: unknown) => {
        const name = nameOf(output)
        const what = [
          input.styles?.length ? plural(input.styles.length, 'range') : '',
          input.columns?.length ? plural(input.columns.length, 'column width') : '',
          input.rows?.length ? plural(input.rows.length, 'row height') : '',
        ]
          .filter(Boolean)
          .join(', ')
        return name
          ? `Formatted ${what} in ${input.sheet} of ${name} in Drive`
          : `Tried to format cells in file ${input.file_id} in Drive`
      },
      inputSchema: formatInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = formatInput.parse(input)
        if (!i.styles?.length && !i.columns?.length && !i.rows?.length)
          throw new DriveError('invalid', 'Nothing to format: give styles, columns or rows.')
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        await guarded(lib, () => {
          for (const op of toOps(lib, i)) editor.apply(op)
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: editor.wb.requireWorksheet(i.sheet).name }
      },
    },
  ]
}
