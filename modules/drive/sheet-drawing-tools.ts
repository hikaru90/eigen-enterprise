import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { SHAPE_GEOMETRIES } from '$lib/office/xlsx/drawing-ops'
import type { Workbook } from '$lib/office/xlsx/workbook'
import { DRIVE_MODULE_ID } from './manifest'
import { DriveError } from './service'
import {
  cellRef,
  DRIVE_ROLES,
  fileId,
  guarded,
  nameOf,
  openBook,
  save,
  sheetName,
  xlsx,
  type DriveSheetToolDeps,
  type Xlsx,
} from './sheet-tools'
import { actorOf } from './tools'

/**
 * drive.sheet_picture_* & drive.sheet_shape_* — insert, move/resize/restyle,
 * and delete pictures, preset shapes and text boxes on Excel worksheets
 * (src/lib/office/xlsx/drawing-ops.ts), saved through Drive as new revisions.
 */

const drawingLib = async () => {
  const [drawing, drawingOps] = await Promise.all([
    import('$lib/office/xlsx/drawing'),
    import('$lib/office/xlsx/drawing-ops'),
  ])
  return { drawing, drawingOps }
}

const hexColor = z
  .string()
  .regex(/^#[0-9A-Fa-f]{6}$/)
  .describe('A hex colour like #4472C4')

const coord = z.number().finite().min(0).max(1_000_000)
const sizeDim = z.number().finite().min(1).max(20_000)
const heightDim = z.number().finite().min(0).max(20_000)
const objectId = z.string().min(1).describe('The object id returned by drive.sheet_read or insert/create')

const pictureInsertInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    image_file_id: fileId.optional().describe('Drive id of a PNG, JPEG, GIF or BMP image file'),
    image_base64: z.string().min(1).optional().describe('Base64-encoded PNG, JPEG, GIF or BMP bytes (or data URL)'),
    cell: cellRef.optional().describe('Top-left anchor cell (e.g. B2); cannot be combined with x/y'),
    x: coord.optional().describe('Pixels right of column A'),
    y: coord.optional().describe('Pixels below row 1'),
    width: sizeDim.optional().describe('Width in pixels (defaults to image width, scaled to at most 640)'),
    height: sizeDim.optional().describe('Height in pixels (defaults proportionally)'),
    name: z.string().min(1).max(100).optional(),
    alt: z.string().max(1000).optional().describe('Alternative text'),
  })
  .strict()

const pictureUpdateInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    id: objectId,
    cell: cellRef.optional().describe('New top-left cell (cannot be combined with x/y)'),
    x: coord.optional(),
    y: coord.optional(),
    width: sizeDim.optional(),
    height: sizeDim.optional(),
    name: z.string().min(1).max(100).optional(),
    alt: z.string().max(1000).optional(),
    rotation: z.number().finite().optional().describe('Clockwise rotation in degrees'),
  })
  .strict()

const pictureDeleteInput = z.object({ file_id: fileId, sheet: sheetName, id: objectId }).strict()

const shapeCreateInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    geometry: z.enum(SHAPE_GEOMETRIES).default('rect').describe('DrawingML preset geometry'),
    textbox: z.boolean().optional().describe('True to create a text box instead of a filled shape'),
    cell: cellRef.optional().describe('Top-left anchor cell (cannot be combined with x/y)'),
    x: coord.optional().describe('Pixels right of column A'),
    y: coord.optional().describe('Pixels below row 1'),
    width: sizeDim.default(160),
    height: heightDim.default(80),
    text: z.string().max(32_000).optional(),
    fill: hexColor.nullable().optional().describe('Fill colour, or null for no fill'),
    line: hexColor.nullable().optional().describe('Outline colour, or null for no outline'),
    name: z.string().min(1).max(100).optional(),
    alt: z.string().max(1000).optional(),
  })
  .strict()

const shapeUpdateInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    id: objectId,
    cell: cellRef.optional().describe('New top-left cell (cannot be combined with x/y)'),
    x: coord.optional(),
    y: coord.optional(),
    width: sizeDim.optional(),
    height: heightDim.optional(),
    name: z.string().min(1).max(100).optional(),
    alt: z.string().max(1000).optional(),
    rotation: z.number().finite().optional().describe('Clockwise rotation in degrees'),
    text: z.string().max(32_000).optional(),
    fill: hexColor.nullable().optional(),
    line: hexColor.nullable().optional(),
  })
  .strict()

const shapeDeleteInput = z.object({ file_id: fileId, sheet: sheetName, id: objectId }).strict()

function decodeBase64Image(raw: string): Uint8Array {
  const cleaned = raw.replace(/^data:[^;,]+;base64,/i, '').replace(/\s+/g, '')
  if (!cleaned || !/^[A-Za-z0-9+/]+={0,2}$/.test(cleaned) || cleaned.length % 4 !== 0)
    throw new DriveError('invalid', 'image_base64 must be valid base64 image data.')
  return new Uint8Array(Buffer.from(cleaned, 'base64'))
}

function resolveOrigin(
  lib: Xlsx,
  wb: Workbook,
  sheet: string,
  cell: string | undefined,
  x: number | undefined,
  y: number | undefined,
  dops: Awaited<ReturnType<typeof drawingLib>>['drawingOps'],
): { x: number; y: number } {
  if (cell !== undefined && (x !== undefined || y !== undefined))
    throw new DriveError('invalid', 'Give either cell or x/y pixel coordinates, not both.')
  if (cell !== undefined) {
    const addr = lib.ref.requireCell(cell)
    return dops.cellOrigin(wb, sheet, addr.row, addr.col)
  }
  return { x: x ?? 0, y: y ?? 0 }
}

function findObject(
  wb: Workbook,
  sheet: string,
  id: string,
  expectedKinds: readonly string[],
  label: string,
  dlib: Awaited<ReturnType<typeof drawingLib>>,
) {
  const info = wb.requireWorksheet(sheet)
  const g = dlib.drawing.sheetGeometry(wb.sheet(info.name))
  const list = dlib.drawing.readDrawing(wb, info, g)
  const obj = list.find((o) => o.id === id)
  if (!obj) throw new DriveError('invalid', `Sheet “${info.name}” has no drawing object with id ${id}.`)
  if (!expectedKinds.includes(obj.kind))
    throw new DriveError('invalid', `Drawing object ${id} (“${obj.name}”) is a ${obj.kind}, not a ${label}.`)
  const box = obj.anchor ? dlib.drawing.anchorBox(obj.anchor, g) : null
  return { info, obj, box }
}

function mergeUpdatedBox(
  lib: Xlsx,
  wb: Workbook,
  sheet: string,
  current: { x: number; y: number; w: number; h: number } | null,
  opts: { cell?: string; x?: number; y?: number; width?: number; height?: number },
  dops: Awaited<ReturnType<typeof drawingLib>>['drawingOps'],
) {
  const hasPos = opts.cell !== undefined || opts.x !== undefined || opts.y !== undefined
  const hasSize = opts.width !== undefined || opts.height !== undefined
  if (!hasPos && !hasSize) return undefined
  if (opts.cell !== undefined && (opts.x !== undefined || opts.y !== undefined))
    throw new DriveError('invalid', 'Give either cell or x/y pixel coordinates, not both.')
  if (!current) throw new DriveError('invalid', 'This object has no movable anchor.')
  let x = current.x
  let y = current.y
  if (opts.cell !== undefined) {
    const addr = lib.ref.requireCell(opts.cell)
    const pt = dops.cellOrigin(wb, sheet, addr.row, addr.col)
    x = pt.x
    y = pt.y
  } else {
    if (opts.x !== undefined) x = opts.x
    if (opts.y !== undefined) y = opts.y
  }
  return {
    x,
    y,
    w: opts.width ?? current.w,
    h: opts.height ?? current.h,
  }
}

export function createDriveSheetDrawingTools({ service, sheetLive }: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_picture_insert',
      module: DRIVE_MODULE_ID,
      summary:
        'Insert a picture (PNG, JPEG, GIF or BMP) onto an Excel worksheet from a Drive image file (image_file_id) or base64 (image_base64), placed at a cell (e.g. "B2") or x/y pixels, with optional width, height, name and alt text.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof pictureInsertInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Inserted a picture in ${input.sheet} of ${name} in Drive`
          : `Tried to insert a picture in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: pictureInsertInput,
      handler: async (ctx, input) => {
        const i = pictureInsertInput.parse(input)
        if ((i.image_file_id ? 1 : 0) + (i.image_base64 ? 1 : 0) !== 1)
          throw new DriveError('invalid', 'Give either image_file_id or image_base64, not both.')
        const drive = await service()
        const [lib, dlib] = await Promise.all([xlsx(), drawingLib()])
        const image = i.image_file_id
          ? (await drive.readFile(actorOf(ctx), i.image_file_id)).bytes
          : decodeBase64Image(i.image_base64!)
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const res = await guarded(lib, () => {
          const { x, y } = resolveOrigin(lib, editor.wb, i.sheet, i.cell, i.x, i.y, dlib.drawingOps)
          return editor.apply({
            op: 'insert_picture',
            sheet: i.sheet,
            image,
            x,
            y,
            width: i.width,
            height: i.height,
            name: i.name,
            alt: i.alt,
          })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const drawing = await guarded(lib, () =>
          lib.read.readSheetAnnotations(editor, res.sheets[0]!).drawings.find((d) => d.id === res.created),
        )
        return { ...saved, sheet: res.sheets[0]!, id: res.created!, drawing }
      },
    },
    {
      name: 'drive.sheet_picture_update',
      module: DRIVE_MODULE_ID,
      summary:
        'Move, resize, rename, rotate or update alternative text on a picture in an Excel worksheet.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof pictureUpdateInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Updated picture ${input.id} in ${input.sheet} of ${name} in Drive`
          : `Tried to update a picture in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: pictureUpdateInput,
      handler: async (ctx, input) => {
        const i = pictureUpdateInput.parse(input)
        const drive = await service()
        const [lib, dlib] = await Promise.all([xlsx(), drawingLib()])
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const sheetNameResolved = await guarded(lib, () => {
          const { info, box } = findObject(editor.wb, i.sheet, i.id, ['picture'], 'picture', dlib)
          const nextBox = mergeUpdatedBox(lib, editor.wb, info.name, box, i, dlib.drawingOps)
          if (!nextBox && i.name === undefined && i.alt === undefined && i.rotation === undefined)
            throw new DriveError('invalid', 'Nothing to update on the picture.')
          editor.apply({
            op: 'update_drawing',
            sheet: info.name,
            id: i.id,
            box: nextBox,
            name: i.name,
            alt: i.alt,
            rotation: i.rotation,
          })
          return info.name
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const drawing = await guarded(lib, () =>
          lib.read.readSheetAnnotations(editor, sheetNameResolved).drawings.find((d) => d.id === i.id),
        )
        return { ...saved, sheet: sheetNameResolved, id: i.id, drawing }
      },
    },
    {
      name: 'drive.sheet_picture_delete',
      module: DRIVE_MODULE_ID,
      summary: 'Delete a picture from an Excel worksheet (removing its embedded media when unused).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof pictureDeleteInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Deleted picture ${input.id} in ${input.sheet} of ${name} in Drive`
          : `Tried to delete a picture in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: pictureDeleteInput,
      handler: async (ctx, input) => {
        const i = pictureDeleteInput.parse(input)
        const drive = await service()
        const [lib, dlib] = await Promise.all([xlsx(), drawingLib()])
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const sheetNameResolved = await guarded(lib, () => {
          const { info } = findObject(editor.wb, i.sheet, i.id, ['picture'], 'picture', dlib)
          editor.apply({ op: 'delete_drawing', sheet: info.name, id: i.id })
          return info.name
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: sheetNameResolved, deleted: i.id }
      },
    },
    {
      name: 'drive.sheet_shape_create',
      module: DRIVE_MODULE_ID,
      summary:
        'Create a preset shape (rect, roundRect, ellipse, triangle, diamond, rightArrow, leftArrow, upArrow, downArrow, line, arrow) or text box on an Excel worksheet, placed at a cell or x/y pixels.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof shapeCreateInput>, output: unknown) => {
        const name = nameOf(output)
        const what = input.textbox ? 'a text box' : `a ${input.geometry} shape`
        return name
          ? `Added ${what} in ${input.sheet} of ${name} in Drive`
          : `Tried to add a shape in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: shapeCreateInput,
      handler: async (ctx, input) => {
        const i = shapeCreateInput.parse(input)
        const drive = await service()
        const [lib, dlib] = await Promise.all([xlsx(), drawingLib()])
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const res = await guarded(lib, () => {
          const { x, y } = resolveOrigin(lib, editor.wb, i.sheet, i.cell, i.x, i.y, dlib.drawingOps)
          return editor.apply({
            op: 'insert_shape',
            sheet: i.sheet,
            geometry: i.geometry,
            textbox: i.textbox,
            x,
            y,
            width: i.width,
            height: i.height,
            text: i.text,
            fill: i.fill,
            line: i.line,
            name: i.name,
            alt: i.alt,
          })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const drawing = await guarded(lib, () =>
          lib.read.readSheetAnnotations(editor, res.sheets[0]!).drawings.find((d) => d.id === res.created),
        )
        return { ...saved, sheet: res.sheets[0]!, id: res.created!, drawing }
      },
    },
    {
      name: 'drive.sheet_shape_update',
      module: DRIVE_MODULE_ID,
      summary:
        'Move, resize, rename, rotate, or update text, fill colour, outline colour, or alternative text of a shape, text box, or connector on an Excel worksheet.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof shapeUpdateInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Updated shape ${input.id} in ${input.sheet} of ${name} in Drive`
          : `Tried to update a shape in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: shapeUpdateInput,
      handler: async (ctx, input) => {
        const i = shapeUpdateInput.parse(input)
        const drive = await service()
        const [lib, dlib] = await Promise.all([xlsx(), drawingLib()])
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const sheetNameResolved = await guarded(lib, () => {
          const { info, box } = findObject(
            editor.wb,
            i.sheet,
            i.id,
            ['shape', 'textbox', 'connector'],
            'shape or text box',
            dlib,
          )
          const nextBox = mergeUpdatedBox(lib, editor.wb, info.name, box, i, dlib.drawingOps)
          if (
            !nextBox &&
            i.name === undefined &&
            i.alt === undefined &&
            i.rotation === undefined &&
            i.text === undefined &&
            i.fill === undefined &&
            i.line === undefined
          ) {
            throw new DriveError('invalid', 'Nothing to update on the shape.')
          }
          editor.apply({
            op: 'update_drawing',
            sheet: info.name,
            id: i.id,
            box: nextBox,
            name: i.name,
            alt: i.alt,
            rotation: i.rotation,
            text: i.text,
            fill: i.fill,
            line: i.line,
          })
          return info.name
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        const drawing = await guarded(lib, () =>
          lib.read.readSheetAnnotations(editor, sheetNameResolved).drawings.find((d) => d.id === i.id),
        )
        return { ...saved, sheet: sheetNameResolved, id: i.id, drawing }
      },
    },
    {
      name: 'drive.sheet_shape_delete',
      module: DRIVE_MODULE_ID,
      summary: 'Delete a shape, text box, or connector from an Excel worksheet.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof shapeDeleteInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Deleted shape ${input.id} in ${input.sheet} of ${name} in Drive`
          : `Tried to delete a shape in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: shapeDeleteInput,
      handler: async (ctx, input) => {
        const i = shapeDeleteInput.parse(input)
        const drive = await service()
        const [lib, dlib] = await Promise.all([xlsx(), drawingLib()])
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const sheetNameResolved = await guarded(lib, () => {
          const { info } = findObject(
            editor.wb,
            i.sheet,
            i.id,
            ['shape', 'textbox', 'connector'],
            'shape or text box',
            dlib,
          )
          editor.apply({ op: 'delete_drawing', sheet: info.name, id: i.id })
          return info.name
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: sheetNameResolved, deleted: i.id }
      },
    },
  ]
}
