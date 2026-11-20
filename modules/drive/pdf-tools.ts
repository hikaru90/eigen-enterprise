import type { DriveService, ItemView } from './service'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { OrganiseResult, PdfSource } from '$lib/office/pdf/organise'
import { DRIVE_MODULE_ID } from './manifest'
import { officeKind } from './preview'
import { DriveError } from './service'
import { actorOf } from './tools'

/**
 * drive.pdf_* — the PDF viewer's Organise mode as registry actions
 * (plan/phase-office-files.md P2): rotate, delete and reorder pages in place
 * (a new revision, like a save in the viewer), extract and split into new
 * files, merge several PDFs into a new one. Pages are numbered from 1.
 *
 * Everything goes through the Drive service as the caller (readFile,
 * writeBytes, upload): the same access checks and edit lock as a person in
 * the viewer — a PDF someone has open in Organise mode is refused while
 * they edit. What the result could not keep (a bookmark to a deleted page,
 * a form field that lived only there) comes back in `warnings`.
 */

export type DrivePdfToolDeps = { service: () => Promise<DriveService> }

/** Every member's own Drive access (as the other drive.* tools). */
const DRIVE_ROLES = ['admin', 'member', 'agent']
const MAX_PAGES_LISTED = 10_000

const fileId = z.string().min(1)
const pageNumbers = z
  .array(z.number().int().min(1))
  .min(1)
  .max(MAX_PAGES_LISTED)
  .describe('Page numbers, starting at 1')
const folderId = z
  .string()
  .min(1)
  .nullable()
  .optional()
  .describe(
    'Where the new file goes: a folder id, null for the top level; omitted: next to the source',
  )
const newName = z.string().trim().min(1).max(255).optional()

const rotateInput = z
  .object({
    file_id: fileId,
    pages: pageNumbers,
    degrees: z
      .union([z.literal(90), z.literal(180), z.literal(270), z.literal(-90)])
      .describe('Clockwise; -90 turns anticlockwise'),
  })
  .strict()
const deleteInput = z.object({ file_id: fileId, pages: pageNumbers }).strict()
const reorderInput = z.union([
  z
    .object({
      file_id: fileId,
      order: pageNumbers.describe('Every page number once, in the new order'),
    })
    .strict(),
  z
    .object({
      file_id: fileId,
      pages: pageNumbers.describe('The pages to move (they keep their order)'),
      to: z
        .number()
        .int()
        .min(1)
        .describe('The page number the first moved page will have afterwards'),
    })
    .strict(),
])
const extractInput = z
  .object({ file_id: fileId, pages: pageNumbers, name: newName, folder_id: folderId })
  .strict()
const splitInput = z
  .object({
    file_id: fileId,
    ranges: z
      .array(z.object({ from: z.number().int().min(1), to: z.number().int().min(1) }).strict())
      .min(1)
      .max(100)
      .describe('One new file per range of pages (from–to, inclusive)'),
    folder_id: folderId,
  })
  .strict()
const mergeInput = z
  .object({
    file_ids: z.array(fileId).min(2).max(50).describe('The PDFs to merge, in order'),
    name: newName,
    folder_id: folderId.describe(
      'Where the merged file goes: a folder id, null for the top level; omitted: next to the first PDF',
    ),
  })
  .strict()

type Organise = typeof import('$lib/office/pdf/organise')
/** pdf-lib loads only when a PDF is organised, not with the registry. */
const organise = (): Promise<Organise> => import('$lib/office/pdf/organise')

async function readPdf(drive: DriveService, ctx: ToolContext, id: string) {
  const { file, bytes } = await drive.readFile(actorOf(ctx), id)
  if (officeKind(file.name, file.mime) !== 'pdf')
    throw new DriveError('invalid', `“${file.name}” is not a PDF, so its pages can’t be organised.`)
  return { file, source: { bytes, name: file.name } satisfies PdfSource }
}

/** An organise refusal (no such page, password-protected, unreadable) is the caller's mistake. */
async function run<T>(work: (lib: Organise) => Promise<T>): Promise<T> {
  const lib = await organise()
  try {
    return await work(lib)
  } catch (err) {
    if (err instanceof lib.PdfOrganiseError)
      throw new DriveError('invalid', err.message, undefined, { cause: err })
    throw err
  }
}

const zeroBased = (pages: number[]) => pages.map((p) => p - 1)
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "2–4, 7" for the pages 2, 3, 4 and 7. */
export function pageRangesLabel(pages: number[]): string {
  const sorted = [...new Set(pages)].sort((a, b) => a - b)
  const parts: string[] = []
  for (let i = 0; i < sorted.length; i++) {
    let j = i
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j]! + 1) j++
    parts.push(j === i ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`)
    i = j
  }
  return parts.join(', ')
}

function baseName(name: string): string {
  return name.toLowerCase().endsWith('.pdf') ? name.slice(0, -4) : name
}

function pdfName(name: string): string {
  return name.toLowerCase().endsWith('.pdf') ? name : `${name}.pdf`
}

type Saved = { file: ItemView; revision: { id: string; createdAt: Date }; warnings: string[] }

async function saveInPlace(
  drive: DriveService,
  ctx: ToolContext,
  id: string,
  result: OrganiseResult,
): Promise<Saved> {
  const out = await drive.writeBytes(actorOf(ctx), id, result.bytes)
  return {
    file: out.file,
    revision: { id: out.revision.id, createdAt: out.revision.createdAt },
    warnings: result.warnings,
  }
}

async function addPdf(
  drive: DriveService,
  ctx: ToolContext,
  folder: string | null,
  name: string,
  bytes: Uint8Array,
): Promise<ItemView> {
  return drive.upload(actorOf(ctx), folder, { name: pdfName(name), bytes, mime: 'application/pdf' })
}

const nameOf = (output: unknown, key: 'file' | 'source') =>
  (output as Record<string, { name?: string } | undefined> | undefined)?.[key]?.name

export function createDrivePdfTools({ service }: DrivePdfToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.pdf_rotate',
      module: DRIVE_MODULE_ID,
      summary:
        'Turn pages of a PDF in Drive (file_id; pages numbered from 1; degrees 90, 180 or 270 clockwise, -90 anticlockwise). Saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof rotateInput>, output: unknown) => {
        const name = nameOf(output, 'file')
        return name
          ? `Rotated ${plural(input.pages.length, 'page')} of ${name} in Drive`
          : `Tried to rotate pages of file ${input.file_id} in Drive`
      },
      inputSchema: rotateInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = rotateInput.parse(input)
        const drive = await service()
        const { source } = await readPdf(drive, ctx, i.file_id)
        const result = await run((lib) => lib.rotatePages(source, zeroBased(i.pages), i.degrees))
        return saveInPlace(drive, ctx, i.file_id, result)
      },
    },
    {
      name: 'drive.pdf_delete_pages',
      module: DRIVE_MODULE_ID,
      summary:
        'Delete pages from a PDF in Drive (file_id; pages numbered from 1; at least one page stays). Saved as a new revision that can be restored. Bookmarks, links and form fields that only belonged to the deleted pages go too; the result lists them in warnings.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof deleteInput>, output: unknown) => {
        const name = nameOf(output, 'file')
        return name
          ? `Deleted ${plural(input.pages.length, 'page')} from ${name} in Drive`
          : `Tried to delete pages from file ${input.file_id} in Drive`
      },
      inputSchema: deleteInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = deleteInput.parse(input)
        const drive = await service()
        const { source } = await readPdf(drive, ctx, i.file_id)
        const result = await run((lib) => lib.deletePages(source, zeroBased(i.pages)))
        return saveInPlace(drive, ctx, i.file_id, result)
      },
    },
    {
      name: 'drive.pdf_reorder',
      module: DRIVE_MODULE_ID,
      summary:
        'Put the pages of a PDF in Drive in a new order (file_id), either with order (every page number once, from 1, in the new order) or by moving pages (the page numbers, which keep their order) so the first becomes page to. Saved as a new revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof reorderInput>, output: unknown) => {
        const name = nameOf(output, 'file')
        return name
          ? `Reordered the pages of ${name} in Drive`
          : `Tried to reorder the pages of file ${input.file_id} in Drive`
      },
      inputSchema: reorderInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = reorderInput.parse(input)
        const drive = await service()
        const { source } = await readPdf(drive, ctx, i.file_id)
        const result = await run((lib) =>
          'order' in i
            ? lib.reorderPages(source, zeroBased(i.order))
            : lib.movePages(source, zeroBased(i.pages), i.to - 1),
        )
        return saveInPlace(drive, ctx, i.file_id, result)
      },
    },
    {
      name: 'drive.pdf_extract_pages',
      module: DRIVE_MODULE_ID,
      summary:
        'Copy pages of a PDF in Drive into a new PDF (file_id; pages numbered from 1, taken in document order; name, default "<name> (pages …).pdf"; folder_id, default next to the source). The source stays as it is.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof extractInput>, output: unknown) => {
        const created = nameOf(output, 'file')
        const from = nameOf(output, 'source')
        return created && from
          ? `Extracted ${plural(input.pages.length, 'page')} of ${from} into ${created} in Drive`
          : `Tried to extract pages of file ${input.file_id} in Drive`
      },
      inputSchema: extractInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = extractInput.parse(input)
        const drive = await service()
        const { file, source } = await readPdf(drive, ctx, i.file_id)
        const result = await run((lib) => lib.extractPages(source, zeroBased(i.pages)))
        const name = i.name ?? `${baseName(file.name)} (pages ${pageRangesLabel(i.pages)})`
        const folder = i.folder_id === undefined ? file.folderId : i.folder_id
        const created = await addPdf(drive, ctx, folder, name, result.bytes)
        return {
          file: created,
          source: { id: file.id, name: file.name },
          warnings: result.warnings,
        }
      },
    },
    {
      name: 'drive.pdf_split',
      module: DRIVE_MODULE_ID,
      summary:
        'Split a PDF in Drive into new PDFs, one per range of pages (file_id; ranges [{ from, to }], numbered from 1, inclusive; folder_id, default next to the source). Each new file is named "<name> (pages from–to).pdf"; the source stays as it is.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof splitInput>, output: unknown) => {
        const from = nameOf(output, 'source')
        const made = (output as { files?: unknown[] } | undefined)?.files?.length
        return from && made
          ? `Split ${from} into ${plural(made, 'file')} in Drive`
          : `Tried to split file ${input.file_id} in Drive`
      },
      inputSchema: splitInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = splitInput.parse(input)
        const drive = await service()
        const { file, source } = await readPdf(drive, ctx, i.file_id)
        const parts = await run((lib) =>
          lib.splitPdf(
            source,
            i.ranges.map((r) => ({ from: r.from - 1, to: r.to - 1 })),
          ),
        )
        const folder = i.folder_id === undefined ? file.folderId : i.folder_id
        const files: ItemView[] = []
        const warnings: Array<{ file: string; warning: string }> = []
        for (const [k, part] of parts.entries()) {
          const r = i.ranges[k]!
          const label = r.from === r.to ? `page ${r.from}` : `pages ${r.from}–${r.to}`
          const created = await addPdf(
            drive,
            ctx,
            folder,
            `${baseName(file.name)} (${label})`,
            part.bytes,
          )
          files.push(created)
          for (const w of part.warnings) warnings.push({ file: created.name, warning: w })
        }
        return { files, source: { id: file.id, name: file.name }, warnings }
      },
    },
    {
      name: 'drive.pdf_merge',
      module: DRIVE_MODULE_ID,
      summary:
        'Merge PDFs in Drive into one new PDF (file_ids, at least two, in order; name, default "<first name> (merged).pdf"; folder_id, default next to the first PDF). The first PDF’s bookmarks, form and properties lead; the others’ bookmarks and form fields join them. The sources stay as they are.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof mergeInput>, output: unknown) => {
        const created = nameOf(output, 'file')
        return created
          ? `Merged ${plural(input.file_ids.length, 'PDF')} into ${created} in Drive`
          : `Tried to merge ${plural(input.file_ids.length, 'PDF')} in Drive`
      },
      inputSchema: mergeInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = mergeInput.parse(input)
        const drive = await service()
        const read = []
        for (const id of i.file_ids) read.push(await readPdf(drive, ctx, id))
        const first = read[0]!.file
        const result = await run((lib) => lib.mergePdfs(read.map((r) => r.source)))
        const folder = i.folder_id === undefined ? first.folderId : i.folder_id
        const created = await addPdf(
          drive,
          ctx,
          folder,
          i.name ?? `${baseName(first.name)} (merged)`,
          result.bytes,
        )
        return {
          file: created,
          sources: read.map((r) => ({ id: r.file.id, name: r.file.name })),
          warnings: result.warnings,
        }
      },
    },
  ]
}
