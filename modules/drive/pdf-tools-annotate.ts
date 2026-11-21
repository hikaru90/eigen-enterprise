import type { DriveService } from './service'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { AnnotationEdit, PdfAnnotation, Rect } from '$lib/office/pdf/annotate-model'
import type { PageBox, PdfEdits } from '$lib/office/pdf/edit'
import { DRIVE_MODULE_ID } from './manifest'
import { officeKind } from './preview'
import { DriveError } from './service'
import { actorOf } from './tools'

/**
 * drive.pdf_* for annotations, forms and properties (plan/phase-office-files.md
 * P3) — what the viewer's Annotate, Fill form and Properties modes do, as
 * registry actions. Pages are numbered from 1; positions are points (1/72
 * inch) from the top-left corner of the page as it is stored (before any
 * page rotation), x to the right, y down.
 *
 * Every call goes through the Drive service as the caller (readFile,
 * writeBytes): the same access checks and edit lock as a person in the
 * viewer. Notes and replies are signed with the acting member's name, taken
 * from the Drive's people; a call that acts for no person writes nothing.
 */

export type DrivePdfAnnotateToolDeps = { service: () => Promise<DriveService> }

const DRIVE_ROLES = ['admin', 'member', 'agent']
const MAX_EDITS = 500

const fileId = z.string().min(1)
const pageNumber = z.number().int().min(1).describe('Page number, starting at 1')
const points = z.number().finite()
const hex = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/)
  .describe('A colour as #rrggbb')
const text = z.string().max(10_000)

const listInput = z.object({ file_id: fileId, page: pageNumber.optional() }).strict()
const noteInput = z
  .object({
    file_id: fileId,
    page: pageNumber,
    x: points.min(0).describe('Points from the left edge of the page'),
    y: points.min(0).describe('Points down from the top edge of the page'),
    text: text.min(1),
    color: hex.optional().describe('The note’s colour, #rrggbb (default yellow)'),
  })
  .strict()
const replyInput = z
  .object({ file_id: fileId, annotation_id: z.string().min(1), text: text.min(1) })
  .strict()
const box = z
  .object({ x: points, y: points, width: points.positive(), height: points.positive() })
  .strict()
const xy = z.object({ x: points, y: points }).strict()
const style = { color: hex, opacity: z.number().gt(0).max(1).optional() }
const addShape = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.enum(['Highlight', 'Underline', 'StrikeOut', 'Squiggly']),
      boxes: z.array(box).min(1).max(200).describe('One box per line of text'),
      ...style,
      text: text.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('Text'), at: xy, ...style, text: text.min(1) }).strict(),
  z
    .object({
      kind: z.literal('Ink'),
      paths: z.array(z.array(xy).min(1).max(5000)).min(1).max(100),
      width: points.positive().max(50),
      ...style,
    })
    .strict(),
  z
    .object({
      kind: z.literal('FreeText'),
      box,
      font_size: points.positive().max(200).optional(),
      ...style,
      text: text.min(1),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['Square', 'Circle']),
      box,
      width: points.min(0).max(50).optional(),
      fill: hex.optional(),
      ...style,
      text: text.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('Line'),
      from: xy,
      to: xy,
      width: points.positive().max(50).optional(),
      arrow: z.enum(['none', 'end', 'start', 'both']).optional(),
      ...style,
      text: text.optional(),
    })
    .strict(),
])
const editInput = z
  .object({
    file_id: fileId,
    edits: z
      .array(
        z.discriminatedUnion('op', [
          z.object({ op: z.literal('add'), page: pageNumber, annotation: addShape }).strict(),
          z
            .object({
              op: z.literal('update'),
              id: z.string().min(1),
              color: hex.optional(),
              opacity: z.number().gt(0).max(1).optional(),
              text: text.optional(),
              move: z
                .object({ dx: points, dy: points.describe('Points down') })
                .strict()
                .optional(),
            })
            .strict(),
          z.object({ op: z.literal('delete'), id: z.string().min(1) }).strict(),
          z
            .object({
              op: z.literal('review'),
              id: z.string().min(1),
              state: z.enum(['None', 'Accepted', 'Rejected', 'Cancelled', 'Completed']),
            })
            .strict(),
        ]),
      )
      .min(1)
      .max(MAX_EDITS),
  })
  .strict()
const fieldValue = z.union([
  z.string().max(10_000),
  z.boolean(),
  z.array(z.string().max(1000)).max(500),
])
const fillInput = z
  .object({
    file_id: fileId,
    values: z
      .record(z.string(), fieldValue)
      .describe(
        'Field name → value: text, true/false for a checkbox, an option (or options) for radio buttons and lists',
      ),
    flatten: z
      .boolean()
      .optional()
      .describe(
        'Also turn the form into page content: the values stay, the fields can no longer be changed',
      ),
  })
  .strict()
  .refine(
    (i) => Object.keys(i.values).length > 0 || i.flatten,
    'Name at least one field, or flatten.',
  )
const propertiesInput = z
  .object({
    file_id: fileId,
    title: z.string().max(2000).optional(),
    author: z.string().max(2000).optional(),
    subject: z.string().max(2000).optional(),
    keywords: z.string().max(2000).optional(),
  })
  .strict()
  .refine(
    (i) => ['title', 'author', 'subject', 'keywords'].some((k) => k in i),
    'Name at least one property.',
  )

type Edit = typeof import('$lib/office/pdf/edit')
type Model = typeof import('$lib/office/pdf/annotate-model')
/** pdf-lib loads only when a PDF is annotated, not with the registry. */
const libs = async (): Promise<Edit & Model> => ({
  ...(await import('$lib/office/pdf/annotate-model')),
  ...(await import('$lib/office/pdf/edit')),
})

async function readPdf(drive: DriveService, ctx: ToolContext, id: string) {
  const { file, bytes } = await drive.readFile(actorOf(ctx), id)
  if (officeKind(file.name, file.mime) !== 'pdf')
    throw new DriveError('invalid', `“${file.name}” is not a PDF.`)
  return { file, source: { bytes, name: file.name } }
}

async function run<T>(work: (lib: Edit & Model) => Promise<T>): Promise<T> {
  const lib = await libs()
  try {
    return await work(lib)
  } catch (err) {
    if (err instanceof lib.PdfEditError)
      throw new DriveError('invalid', err.message, undefined, { cause: err })
    throw err
  }
}

/** The member a note is signed with: the acting person, by their Drive name. Never anonymous. */
async function authorOf(drive: DriveService, ctx: ToolContext): Promise<string> {
  if (ctx.principal.kind !== 'human')
    throw new DriveError(
      'forbidden',
      'Notes are signed by a person; this call acts for no one, so it writes nothing.',
    )
  const person = (await drive.shareTargets()).people.find((p) => p.id === ctx.principal.id)
  const name = person ? person.name || person.email : ''
  if (!name)
    throw new DriveError(
      'forbidden',
      'Notes are signed by the member’s name, and this member has none in the Drive.',
    )
  return name
}

// --- page coordinates (top-left, y down) ↔ PDF user space ------------------------

function pageOf(pages: PageBox[], page: number): PageBox {
  const p = pages[page - 1]
  if (!p)
    throw new DriveError('invalid', `There is no page ${page}; the PDF has ${pages.length} pages.`)
  return p
}
const toPdf = (p: PageBox, x: number, y: number): [number, number] => [p.box[0] + x, p.box[3] - y]
function boxToRect(p: PageBox, b: { x: number; y: number; width: number; height: number }): Rect {
  const [x1, y2] = toPdf(p, b.x, b.y)
  return [x1, y2 - b.height, x1 + b.width, y2]
}
function placeOf(p: PageBox, r: Rect) {
  const round = (n: number) => Math.round(n * 100) / 100
  return {
    x: round(r[0] - p.box[0]),
    y: round(p.box[3] - r[3]),
    width: round(r[2] - r[0]),
    height: round(r[3] - r[1]),
  }
}

function describe(lib: Model, pages: PageBox[], a: PdfAnnotation) {
  return {
    id: a.id,
    page: a.page + 1,
    kind: a.kind === 'Other' ? a.subtype : a.kind,
    label: lib.kindLabel(a.kind),
    ...placeOf(pages[a.page]!, a.rect),
    color: a.color ? lib.rgbHex(a.color) : null,
    opacity: a.opacity,
    author: a.author,
    text: a.contents,
    modified: a.modified,
    created: a.created,
    in_reply_to: a.inReplyTo,
    review: a.review,
  }
}

const YELLOW = '#ffd400'

function toEdits(
  lib: Model,
  pages: PageBox[],
  input: z.infer<typeof editInput>['edits'],
): AnnotationEdit[] {
  return input.map((e, k): AnnotationEdit => {
    if (e.op === 'delete') return { op: 'delete', id: e.id }
    if (e.op === 'review') return { op: 'review', id: e.id, state: e.state }
    if (e.op === 'update')
      return {
        op: 'update',
        id: e.id,
        patch: {
          ...(e.color ? { color: lib.hexRgb(e.color) } : {}),
          ...(e.opacity !== undefined ? { opacity: e.opacity } : {}),
          ...(e.text !== undefined ? { contents: e.text } : {}),
          ...(e.move ? { move: [e.move.dx, -e.move.dy] as [number, number] } : {}),
        },
      }
    const p = pageOf(pages, e.page)
    const a = e.annotation
    const pt = (q: { x: number; y: number }) => toPdf(p, q.x, q.y)
    const shape = ((): import('$lib/office/pdf/annotate-model').AnnotationShape => {
      switch (a.kind) {
        case 'Highlight':
        case 'Underline':
        case 'StrikeOut':
        case 'Squiggly':
          return { kind: a.kind, quads: a.boxes.map((b) => lib.quadOf(boxToRect(p, b))) }
        case 'Text':
          return { kind: 'Text', at: pt(a.at) }
        case 'Ink':
          return { kind: 'Ink', paths: a.paths.map((path) => path.flatMap(pt)), width: a.width }
        case 'FreeText':
          return { kind: 'FreeText', rect: boxToRect(p, a.box), fontSize: a.font_size ?? 12 }
        case 'Square':
        case 'Circle':
          return {
            kind: a.kind,
            rect: boxToRect(p, a.box),
            width: a.width ?? 1,
            fill: a.fill ? lib.hexRgb(a.fill) : null,
          }
        case 'Line': {
          const arrow = a.arrow ?? 'end'
          return {
            kind: 'Line',
            line: [...pt(a.from), ...pt(a.to)],
            width: a.width ?? 1,
            ends: [
              arrow === 'start' || arrow === 'both' ? 'OpenArrow' : 'None',
              arrow === 'end' || arrow === 'both' ? 'OpenArrow' : 'None',
            ],
          }
        }
      }
    })()
    return {
      op: 'add',
      key: `new:${k}`,
      annotation: {
        page: e.page - 1,
        shape,
        color: lib.hexRgb(a.color),
        opacity: a.opacity ?? 1,
        contents: a.text ?? '',
      },
    }
  })
}

const nameOf = (output: unknown) => (output as { file?: { name?: string } } | undefined)?.file?.name
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export function createDrivePdfAnnotateTools({
  service,
}: DrivePdfAnnotateToolDeps): ToolDescriptor[] {
  /** Reads, edits as the caller, saves one new revision. */
  async function editInPlace(
    ctx: ToolContext,
    id: string,
    edits: (lib: Edit & Model, pages: PageBox[]) => PdfEdits,
    signed = true,
  ) {
    const drive = await service()
    const { source } = await readPdf(drive, ctx, id)
    // Annotations carry their author; form values and properties don't.
    const author = signed ? await authorOf(drive, ctx) : ''
    const { result, pages } = await run(async (lib) => {
      const { pages } = await lib.readPdfContents(source)
      return {
        result: await lib.applyPdfEdits(source, edits(lib, pages), { author, now: new Date() }),
        pages,
      }
    })
    const out = await drive.writeBytes(actorOf(ctx), id, result.bytes)
    return { out, result, pages }
  }

  return [
    {
      name: 'drive.pdf_list_annotations',
      module: DRIVE_MODULE_ID,
      summary:
        'List the notes, highlights, drawings and other annotations of a PDF in Drive (file_id; page, from 1, for one page): id, page, kind, position (points from the page’s top-left corner, y down), colour, author, text, dates, the annotation it replies to and its review state; with each page’s size.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const drive = await service()
        const { source } = await readPdf(drive, ctx, i.file_id)
        return run(async (lib) => {
          const { pages, annotations } = await lib.readPdfContents(source)
          if (i.page !== undefined) pageOf(pages, i.page)
          return {
            pages: pages.map((p, k) => ({
              page: k + 1,
              width: p.box[2] - p.box[0],
              height: p.box[3] - p.box[1],
              rotate: p.rotate,
            })),
            annotations: annotations
              .filter((a) => i.page === undefined || a.page === i.page - 1)
              .map((a) => describe(lib, pages, a)),
          }
        })
      },
    },
    {
      name: 'drive.pdf_add_note',
      module: DRIVE_MODULE_ID,
      summary:
        'Add a sticky note to a page of a PDF in Drive (file_id; page from 1; x, y in points from the page’s top-left corner; text; color #rrggbb, default yellow). Signed with your name; saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof noteInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Added a note on page ${input.page} of ${name} in Drive`
          : `Tried to add a note to file ${input.file_id} in Drive`
      },
      inputSchema: noteInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = noteInput.parse(input)
        const { out, result } = await editInPlace(ctx, i.file_id, (lib, pages) => {
          const p = pageOf(pages, i.page)
          const [w, h] = [p.box[2] - p.box[0], p.box[3] - p.box[1]]
          if (i.x > w || i.y > h)
            throw new DriveError(
              'invalid',
              `Page ${i.page} is ${Math.round(w)} × ${Math.round(h)} points; (${i.x}, ${i.y}) is outside it.`,
            )
          return {
            annotations: [
              {
                op: 'add',
                key: 'new:note',
                annotation: {
                  page: i.page - 1,
                  shape: { kind: 'Text', at: toPdf(p, i.x, i.y) },
                  color: lib.hexRgb(i.color ?? YELLOW),
                  opacity: 1,
                  contents: i.text,
                },
              },
            ],
          }
        })
        return {
          file: out.file,
          revision: { id: out.revision.id, createdAt: out.revision.createdAt },
          annotation_id: result.created['new:note'],
        }
      },
    },
    {
      name: 'drive.pdf_reply',
      module: DRIVE_MODULE_ID,
      summary:
        'Reply to a note or markup of a PDF in Drive (file_id; annotation_id from drive.pdf_list_annotations; text). Signed with your name; saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof replyInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Replied to a comment in ${name} in Drive`
          : `Tried to reply to a comment in file ${input.file_id} in Drive`
      },
      inputSchema: replyInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = replyInput.parse(input)
        const { out, result } = await editInPlace(ctx, i.file_id, () => ({
          annotations: [{ op: 'reply', key: 'new:reply', to: i.annotation_id, contents: i.text }],
        }))
        return {
          file: out.file,
          revision: { id: out.revision.id, createdAt: out.revision.createdAt },
          annotation_id: result.created['new:reply'],
        }
      },
    },
    {
      name: 'drive.pdf_edit_annotations',
      module: DRIVE_MODULE_ID,
      summary:
        'Change the annotations of a PDF in Drive in one revision (file_id; edits, in order): add (page from 1; annotation: Highlight/Underline/StrikeOut/Squiggly over boxes, Text note at a point, Ink paths, FreeText in a box, Square/Circle in a box, Line from–to with arrows; color #rrggbb, opacity), update (id; color, opacity, text, move dx/dy points, dy down), delete (id; its replies go too), review (id; state None/Accepted/Rejected/Cancelled/Completed). Positions in points from the page’s top-left corner.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof editInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Made ${plural(input.edits.length, 'annotation change')} in ${name} in Drive`
          : `Tried to change annotations of file ${input.file_id} in Drive`
      },
      inputSchema: editInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = editInput.parse(input)
        const { out, result } = await editInPlace(ctx, i.file_id, (lib, pages) => ({
          annotations: toEdits(lib, pages, i.edits),
        }))
        return {
          file: out.file,
          revision: { id: out.revision.id, createdAt: out.revision.createdAt },
          added: Object.entries(result.created).map(([key, id]) => ({
            edit: Number(key.slice(4)) + 1,
            id,
          })),
        }
      },
    },
    {
      name: 'drive.pdf_list_form_fields',
      module: DRIVE_MODULE_ID,
      summary:
        'List the form fields of a PDF in Drive (file_id): name, type (text, checkbox, radio, dropdown, listbox, signature, button), value, options, read-only, required, maximum length, and the page each sits on. Says when the form is XFA, which can’t be filled.',
      auditClass: 'read',
      inputSchema: z.object({ file_id: fileId }).strict(),
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = z.object({ file_id: fileId }).strict().parse(input)
        const drive = await service()
        const { source } = await readPdf(drive, ctx, i.file_id)
        return run(async (lib) => {
          const { form } = await lib.readPdfContents(source)
          const { XFA_ONLY_MESSAGE } = await import('$lib/office/pdf/forms')
          return {
            kind: form.kind,
            ...(form.kind === 'xfa-only' ? { note: XFA_ONLY_MESSAGE } : {}),
            fields: form.fields.map((f) => ({
              name: f.name,
              type: f.type,
              value: f.value,
              options: f.options,
              read_only: f.readOnly,
              required: f.required,
              max_length: f.maxLength,
              multiline: f.multiline,
              multiselect: f.multiselect,
              ...(f.type === 'signature' ? { signed: f.signed } : {}),
              pages: [...new Set(f.widgets.map((w) => w.page + 1))],
            })),
          }
        })
      },
    },
    {
      name: 'drive.pdf_fill_form',
      module: DRIVE_MODULE_ID,
      summary:
        'Fill form fields of a PDF in Drive (file_id; values: field name → text, true/false for a checkbox, an option or options for radio buttons and lists; flatten: true also turns the form into page content for good). Read-only, signature and over-long values are refused; saved as a new revision that can be restored; warnings say which required fields are still empty.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof fillInput>, output: unknown) => {
        const name = nameOf(output)
        const n = Object.keys(input.values).length
        return name
          ? `Filled ${plural(n, 'form field')} of ${name}${input.flatten ? ' and flattened the form' : ''} in Drive`
          : `Tried to fill the form of file ${input.file_id} in Drive`
      },
      inputSchema: fillInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = fillInput.parse(input)
        const { out, result } = await editInPlace(
          ctx,
          i.file_id,
          () => ({ fields: i.values, flatten: i.flatten }),
          false,
        )
        return {
          file: out.file,
          revision: { id: out.revision.id, createdAt: out.revision.createdAt },
          warnings: result.warnings,
        }
      },
    },
    {
      name: 'drive.pdf_set_properties',
      module: DRIVE_MODULE_ID,
      summary:
        'Set the document properties of a PDF in Drive (file_id; title, author, subject, keywords; an empty string clears one). Written to the document information and its XMP metadata alike; saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof propertiesInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Set the properties of ${name} in Drive`
          : `Tried to set the properties of file ${input.file_id} in Drive`
      },
      inputSchema: propertiesInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const { file_id, ...properties } = propertiesInput.parse(input)
        const { out } = await editInPlace(ctx, file_id, () => ({ properties }), false)
        return {
          file: out.file,
          revision: { id: out.revision.id, createdAt: out.revision.createdAt },
        }
      },
    },
  ]
}
