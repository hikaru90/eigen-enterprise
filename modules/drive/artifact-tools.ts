import type { BrowserProbe } from '../brand/extract/capture'
import type { ViewScope } from './view-token'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import { actsAsMember } from '$lib/kernel/principals'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { PdfBrowserLauncher } from '$lib/office/xlsx/print-pdf'
import {
  applySlideOps,
  applyTextEdits,
  ARTIFACT_KINDS,
  ArtifactError,
  artifactFileName,
  artifactKindOf,
  DECK_MAX_SLIDES,
  deckDocument,
  deckSlides,
  type ArtifactKind,
  type SlideOp,
} from './artifact'
import { DRIVE_MODULE_ID } from './manifest'
import { renderDriveMarkdown } from './markdown'
import { DriveError, type Actor, type DriveService } from './service'

/**
 * artifacts.* (plan/phase-artifacts.md): HTML pages and slide decks the
 * agent writes into Drive and people see rendered next to the chat. Each is
 * an ordinary Drive file (same access checks, sharing, revisions); the
 * tools only shape its HTML. Writes are mutate-class and wait on the
 * company's approval mode, like drive.write_text. A write's output names
 * the artifact (`artifact: { id, … }`), which is how the chat opens it in
 * its side panel (src/lib/tool-steps/artifact.ts).
 */


export type ArtifactToolDeps = {
  service: () => Promise<DriveService>
  /** Mints the sandboxed view address for a person (src/lib/server/drive-view.ts). */
  viewUrl?: (scope: ViewScope) => Promise<string>
  pdf?: { browser?: BrowserProbe; launch?: PdfBrowserLauncher }
}

const ROLES = ['admin', 'member', 'agent']
const PDF_TIMEOUT_MS = 30_000

const slideInput = z.union([z.object({ html: z.string() }).strict(), z.object({ markdown: z.string() }).strict()])
type SlideInput = z.infer<typeof slideInput>
const slideHtml = (s: SlideInput) => ('html' in s ? s.html : renderDriveMarkdown(s.markdown))

const createInput = z
  .object({
    kind: z.enum(ARTIFACT_KINDS),
    name: z.string().trim().min(1),
    folder_id: z.string().min(1).nullable().optional(),
    content: z.string().optional(),
    slides: z.array(slideInput).max(DECK_MAX_SLIDES).optional(),
    css: z.string().optional(),
  })
  .strict()

const slideOpInput = z.discriminatedUnion('op', [
  z.object({ op: z.literal('replace'), index: z.number().int().min(0), slide: slideInput }).strict(),
  z.object({ op: z.literal('insert'), index: z.number().int().min(0), slide: slideInput }).strict(),
  z.object({ op: z.literal('delete'), index: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal('move'), from: z.number().int().min(0), to: z.number().int().min(0) }).strict(),
])

const updateInput = z
  .object({
    file_id: z.string().min(1),
    content: z.string().optional(),
    edits: z.array(z.object({ find: z.string().min(1), replace: z.string() }).strict()).min(1).optional(),
    slide_ops: z.array(slideOpInput).min(1).optional(),
  })
  .strict()
  .refine((i) => [i.content, i.edits, i.slide_ops].filter((x) => x !== undefined).length === 1, {
    message: 'give exactly one of content (the whole HTML), edits (find/replace) or slide_ops (a deck’s slides)',
  })

const readInput = z.object({ file_id: z.string().min(1), view_url: z.boolean().optional() }).strict()
const exportInput = z.object({ file_id: z.string().min(1), folder_id: z.string().min(1).nullable().optional() }).strict()

/** As drive.* does (./tools.ts actorOf): a person or co-worker as itself, an agent company-wide. */
function actorOf(ctx: ToolContext): Actor {
  return actsAsMember(ctx.principal) ? { kind: 'user', userId: ctx.principal.id } : { kind: 'agent', id: ctx.principal.id }
}

function invalid(err: unknown): never {
  if (err instanceof ArtifactError) throw new KernelError('invalid_input', err.message)
  throw err
}

type ArtifactRef = { id: string; name: string; kind: ArtifactKind; slideCount: number | null }

function refOf(file: { id: string; name: string }, html: string): ArtifactRef {
  const kind = artifactKindOf(file.name)
  if (!kind) throw new DriveError('invalid', `“${file.name}” is not an artifact (an .html page or a .deck.html deck).`)
  return { id: file.id, name: file.name, kind, slideCount: kind === 'deck' ? deckSlides(html).length : null }
}

async function readArtifact(drive: DriveService, actor: Actor, fileId: string) {
  const { file, bytes } = await drive.readFile(actor, fileId)
  if (!artifactKindOf(file.name)) throw new DriveError('invalid', `“${file.name}” is not an artifact (an .html page or a .deck.html deck).`)
  return { file, html: new TextDecoder().decode(bytes) }
}

function pdfName(artifactName: string): string {
  return `${artifactName.replace(/\.(deck\.)?html?$/i, '')}.pdf`
}

async function renderPdf(html: string, deps: ArtifactToolDeps['pdf'] = {}): Promise<Uint8Array> {
  const { requireBrowserExecutable } = await import('../brand/extract/capture')
  const { BrowserUnavailableError } = await import('../brand/extract/capture-errors')
  let executablePath: string
  try {
    executablePath = await requireBrowserExecutable(deps.browser)
  } catch (err) {
    if (err instanceof BrowserUnavailableError)
      throw new DriveError('unavailable', 'Exporting to PDF needs a browser on the server, and this install doesn’t have one.', undefined, { cause: err })
    throw err
  }
  const launch: PdfBrowserLauncher =
    deps.launch ??
    (async (path) => {
      const { chromium } = await import('playwright')
      return (await chromium.launch({ headless: true, executablePath: path })) as never
    })
  const browser = await launch(executablePath)
  try {
    const page = await browser.newPage()
    // The server never fetches for an artifact: inline content only (decision, plan/phase-artifacts.md).
    await page.route('**/*', async (route) => {
      const url = route.request().url()
      if (url.startsWith('data:') || url === 'about:blank') await route.continue()
      else await route.abort()
    })
    await page.setContent(html, { waitUntil: 'load', timeout: PDF_TIMEOUT_MS })
    return new Uint8Array(await page.pdf({ printBackground: true, preferCSSPageSize: true }))
  } finally {
    await browser.close()
  }
}

/**
 * artifacts.export_pdf's work, shared with the Drive's Export PDF button
 * (src/routes/api/drive/artifacts/[id]/pdf): render, then save `<stem>.pdf`
 * next to the artifact (or in folderId), a new revision when it exists.
 */
export async function exportArtifactPdf(
  drive: DriveService,
  actor: Actor,
  fileId: string,
  folderId: string | null | undefined,
  pdf?: ArtifactToolDeps['pdf'],
) {
  const { file, html } = await readArtifact(drive, actor, fileId)
  const bytes = await renderPdf(html, pdf)
  const folder = folderId === undefined ? file.folderId : folderId
  const saved = await drive.upload(actor, folder, { name: pdfName(file.name), bytes, mime: 'application/pdf' }, 'replace')
  return { file: saved, source: { id: file.id, name: file.name } }
}

/** What the chat's artifact panel shows (= artifacts.read with view_url for a person). */
export async function artifactViewFor(
  drive: DriveService,
  userId: string,
  fileId: string,
  viewUrl: (scope: ViewScope) => Promise<string>,
): Promise<{ artifact: ArtifactRef; updatedAt: Date; viewUrl: string }> {
  const { file, html } = await readArtifact(drive, { kind: 'user', userId }, fileId)
  const url = await viewUrl({ userId, folderId: file.folderId, fileId: file.id, fileName: file.name })
  return { artifact: refOf(file, html), updatedAt: file.updatedAt, viewUrl: `${url}?v=${file.sha256.slice(0, 12)}` }
}

export function createArtifactTools(deps: ArtifactToolDeps): ToolDescriptor[] {
  const { service } = deps
  return [
    {
      name: 'artifacts.create',
      module: DRIVE_MODULE_ID,
      summary:
        'Create an artifact in Drive: a rendered HTML page (kind "page": content = the whole HTML document, inline CSS/JS, images as https or data: URLs) or a slide deck (kind "deck": slides = [{ html } or { markdown }], each laid out on a 1920×1080 stage; css = styles for all slides). Use it for pitch decks, one-pagers, layouts, carousels, mockups — anything visual. The person sees it rendered next to the chat, and it updates when you change it (artifacts.update). Lands in their Drive as theirs (folder_id, omit for the top level).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof createInput>, output: unknown) => {
        const name = (output as { artifact?: { name?: string } } | undefined)?.artifact?.name
        return name ? `Created ${name} in Drive` : `Tried to create ${input.name} in Drive`
      },
      inputSchema: createInput,
      permission: { roles: ROLES },
      handler: async (ctx, input) => {
        const i = createInput.parse(input)
        let html: string
        try {
          if (i.kind === 'page') {
            if (i.slides !== undefined || i.css !== undefined) throw new ArtifactError('A page takes content (its whole HTML), not slides or css.')
            if (i.content === undefined) throw new ArtifactError('A page needs content: its whole HTML document.')
            html = i.content
          } else {
            if (i.content !== undefined) throw new ArtifactError('A deck takes slides (and css), not content.')
            if (!i.slides?.length) throw new ArtifactError('A deck needs at least one slide.')
            html = deckDocument({ title: i.name.replace(/\.(deck\.)?html?$/i, ''), css: i.css, slides: i.slides.map(slideHtml) })
          }
        } catch (err) {
          invalid(err)
        }
        const name = artifactFileName(i.kind, i.name)
        const file = await (await service()).upload(actorOf(ctx), i.folder_id ?? null, { name, bytes: new TextEncoder().encode(html), mime: 'text/html' }, 'keep_both')
        return { artifact: refOf(file, html), file }
      },
    },
    {
      name: 'artifacts.update',
      module: DRIVE_MODULE_ID,
      summary:
        'Change an artifact (file_id) with exactly one of: content (the whole new HTML), edits ([{ find, replace }]: exact text, each must occur once — read it first with artifacts.read), or slide_ops for a deck ([{ op: "replace"|"insert", index, slide: { html } or { markdown } } | { op: "delete", index } | { op: "move", from, to }], 0-based, applied in order). Each change is a new revision that can be restored; the person sees it at once.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof updateInput>, output: unknown) => {
        const name = (output as { artifact?: { name?: string } } | undefined)?.artifact?.name
        return name ? `Changed ${name} in Drive` : `Tried to change artifact ${input.file_id} in Drive`
      },
      inputSchema: updateInput,
      permission: { roles: ROLES },
      handler: async (ctx, input) => {
        const i = updateInput.parse(input)
        const drive = await service()
        const { file, html } = await readArtifact(drive, actorOf(ctx), i.file_id)
        let next: string
        try {
          if (i.content !== undefined) next = i.content
          else if (i.edits) next = applyTextEdits(html, i.edits)
          else {
            if (artifactKindOf(file.name) !== 'deck') throw new ArtifactError(`“${file.name}” is a page, not a deck; change it with content or edits.`)
            const ops: SlideOp[] = i.slide_ops!.map((o) => (o.op === 'replace' || o.op === 'insert' ? { op: o.op, index: o.index, html: slideHtml(o.slide) } : o))
            next = applySlideOps(html, ops)
          }
        } catch (err) {
          invalid(err)
        }
        const out = await drive.writeHtml(actorOf(ctx), file.id, next, { baseSha256: file.sha256 })
        return { artifact: refOf(out.file, next), file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
      },
    },
    {
      name: 'artifacts.read',
      module: DRIVE_MODULE_ID,
      summary:
        'Read an artifact (file_id): its kind, its HTML, and for a deck its slides (index → inner HTML) for targeted edits. view_url: true (a person only) also returns the short-lived sandboxed address the page renders at.',
      auditClass: 'read',
      inputSchema: readInput,
      permission: { roles: ROLES },
      handler: async (ctx, input) => {
        const i = readInput.parse(input)
        const { file, html } = await readArtifact(await service(), actorOf(ctx), i.file_id)
        const artifact = refOf(file, html)
        let viewUrl: string | undefined
        if (i.view_url) {
          // The address signs its bearer in as this person on the view route only (an hour): never for an agent's context.
          if (ctx.principal.kind !== 'human' || !actsAsMember(ctx.principal)) throw new KernelError('permission_denied', 'Only a person opens an artifact’s view address.')
          if (!deps.viewUrl) throw new Error('artifacts.read: no view address minter wired')
          viewUrl = (await artifactViewFor(await service(), ctx.principal.id, file.id, deps.viewUrl)).viewUrl
        }
        return {
          artifact,
          updatedAt: file.updatedAt,
          content: html,
          ...(artifact.kind === 'deck' ? { slides: deckSlides(html).map((h, index) => ({ index, html: h })) } : {}),
          ...(viewUrl ? { viewUrl } : {}),
        }
      },
    },
    {
      name: 'artifacts.export_pdf',
      module: DRIVE_MODULE_ID,
      summary:
        'Export an artifact (file_id) to PDF and save it in Drive next to it (or in folder_id): a deck one slide per 1920×1080 page, a page as it prints. Only what is inside the artifact renders (inline styles, data: images); the server fetches nothing.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof exportInput>, output: unknown) => {
        const name = (output as { file?: { name?: string } } | undefined)?.file?.name
        return name ? `Exported ${name} to Drive` : `Tried to export artifact ${input.file_id} to PDF`
      },
      inputSchema: exportInput,
      permission: { roles: ROLES },
      handler: async (ctx, input) => {
        const i = exportInput.parse(input)
        return exportArtifactPdf(await service(), actorOf(ctx), i.file_id, i.folder_id, deps.pdf)
      },
    },
  ]
}
