import type { Actor, DriveService } from './service'
import { z } from 'zod'
import { KernelError } from '$lib/kernel/errors'
import { actsAsMember } from '$lib/kernel/principals'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { ExportPdfDeps } from '$lib/office/xlsx/print-pdf'
import { roleCan } from '$lib/server/auth/capabilities'
import type { MemberRole } from '$lib/server/auth/roles'
import { EeClient } from '$lib/server/ee/client'
import { requireHuman } from '$lib/server/ee/human'
import { appStatus, PREVIEW_ID, runApp, stopApp, type AppPreviewDeps } from './app-preview'
import { liveSuggestChat, SUGGEST_DEFAULT_DAYS, SUGGEST_MAX_DAYS, SUGGEST_MIN_DAYS, suggestArchive, type SuggestChat } from './archive-suggest'
import { createDriveFileTools } from './file-tools'
import { DRIVE_MODULE_ID } from './manifest'
import { createDrivePdfTools } from './pdf-tools'
import { createDrivePdfAnnotateTools } from './pdf-tools-annotate'
import { DOCUMENT_KINDS } from './service'
import { createDriveSheetArrangeTools } from './sheet-arrange-tools'
import { createDriveSheetChartTools } from './sheet-chart-tools'
import { createDriveSheetCommentTools } from './sheet-comment-tools'
import { createDriveSheetCopyTools } from './sheet-copy-tools'
import { createDriveSheetDrawingTools } from './sheet-drawing-tools'
import { createDriveSheetEditingTools } from './sheet-editing-tools'
import { createDriveSheetFormatTools } from './sheet-format-tools'
import { createDriveSheetPivotTableTools } from './sheet-pivot-table-tools'
import { createDriveSheetRulesTools } from './sheet-rules-tools'
import { createDriveSheetTools } from './sheet-tools'

/**
 * drive.* kernel tools: list a folder, read a text file, write a Markdown/CSV
 * file (a new revision), archive and unarchive, list the archive, and ask for
 * archive suggestions. Every call runs through the Drive service's access
 * checks as the calling principal: a person with their own access — also when
 * the company brain acts for them (CB3: the principal IS the person, so the
 * brain sees and changes exactly what they may); an agent principal that is
 * no person keeps the agent's access. Every member reaches these tools (role
 * 'member'). Writing, archiving and unarchiving are mutate-class and wait on
 * the company's approval mode; suggesting changes nothing.
 * drive.app_* run a web app folder on this server through ee (app-preview.ts):
 * status is a read anyone who can view the folder may do; Run and Stop are a
 * person's own act, owner or admin, never done by the brain (D11: refused outright).
 */

export type DriveToolDeps = {
  service?: () => Promise<DriveService>
  /** The gateway call behind drive.suggest_archive (tests inject a fake). */
  chat?: SuggestChat
  now?: () => Date
  /** ee's control API behind drive.app_* (tests inject a recording transport). */
  ee?: EeClient
  /** A person's company role (drive.app_run / app_stop are owner and admins only). */
  roleOf?: (userId: string) => Promise<MemberRole | null>
  /** Where EE_STATE_DIR comes from (the snapshot hand-off dir). */
  env?: Record<string, string | undefined>
  /** Chromium launcher / probe behind drive.sheet_export_pdf (tests inject a fake). */
  pdfDeps?: ExportPdfDeps
}

/** Batch size for one archive/unarchive call (one approval). */
export const ARCHIVE_BATCH_MAX = 100

const listInput = z.object({ folder_id: z.string().min(1).nullable().optional() }).strict()
const readInput = z.object({ file_id: z.string().min(1) }).strict()
/** drive.read returns at most 2 MB of text: more would flood the agent's context; the file stays downloadable. */
export const DRIVE_READ_MAX_BYTES = 2 * 1024 * 1024
const writeInput = z.object({ file_id: z.string().min(1), content: z.string() }).strict()
const createInput = z
  .object({
    name: z.string().trim().min(1),
    kind: z.enum(DOCUMENT_KINDS).optional(),
    content: z.string().optional(),
    folder_id: z.string().min(1).nullable().optional(),
  })
  .strict()
const itemsInput = z
  .object({
    items: z
      .array(z.object({ type: z.enum(['file', 'folder']), id: z.string().min(1) }).strict())
      .min(1)
      .max(ARCHIVE_BATCH_MAX),
  })
  .strict()
const emptyInput = z.object({}).strict()
const suggestInput = z.object({ older_than_days: z.number().int().min(SUGGEST_MIN_DAYS).max(SUGGEST_MAX_DAYS).optional() }).strict()
const folderInput = z.object({ folder_id: z.string().min(1) }).strict()
/** By folder, or by preview id (the one "Another app is running" names). */
const stopInput = z.union([folderInput, z.object({ preview_id: z.string().regex(PREVIEW_ID, 'not an app preview id (pv + 12 hex)') }).strict()])

/**
 * D11 + owner decision 1 (plan/phase-drive-app-preview.md): Run and Stop run
 * uploaded code on this server, so only a person, and only an owner or admin
 * (the kernel role every signed-in caller carries is not the company role).
 */
async function requireAppAdmin(ctx: ToolContext, tool: string, roleOf: (userId: string) => Promise<MemberRole | null>): Promise<string> {
  const author = requireHuman(ctx, tool, 'the folder’s page in Drive')
  if (!roleCan(await roleOf(ctx.principal.id), 'drive.run_apps')) throw new KernelError('permission_denied', 'Only an owner or admin can run or stop apps in Drive.')
  return author
}

async function liveRole(userId: string): Promise<MemberRole | null> {
  const { getUserRole } = await import('$lib/server/auth/user-role')
  return getUserRole(userId)
}

export function actorOf(ctx: ToolContext): Actor {
  // A person or an AI co-worker acts as itself (its own grants); only agents/services act company-wide.
  return actsAsMember(ctx.principal) ? { kind: 'user', userId: ctx.principal.id } : { kind: 'agent', id: ctx.principal.id }
}

/** Every member's own Drive access; the brain reaches it as the member. */
const DRIVE_ROLES = ['admin', 'member', 'agent']

async function liveService(): Promise<DriveService> {
  const { driveService } = await import('./index')
  return driveService()
}

export function createDriveTools(opts: DriveToolDeps = {}): ToolDescriptor[] {
  const service = opts.service ?? liveService
  const chat = opts.chat ?? liveSuggestChat
  const roleOf = opts.roleOf ?? liveRole
  let ee = opts.ee
  const appDeps = async (): Promise<AppPreviewDeps> => ({
    drive: await service(),
    ee: (ee ??= new EeClient()),
    env: opts.env ?? process.env,
    ...(opts.now ? { now: opts.now } : {}),
  })
  return [
    {
      name: 'drive.list',
      module: DRIVE_MODULE_ID,
      summary:
        'List a Drive folder (folder_id; omit for the top level): its folders and files with ids, names, sizes and types. Archived items are left out (drive.list_archived lists them).',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const out = await (await service()).listFolder(actorOf(ctx), i.folder_id ?? null)
        return { folder: out.folder, path: out.path, items: out.items }
      },
    },
    {
      // The Drive rail's "Shared with me" as a registry action (CB3: the brain
      // reads Drive as the person, whose top level holds only their own items).
      name: 'drive.shared_with_me',
      module: DRIVE_MODULE_ID,
      summary:
        'List what other people shared with you in Drive (the top-most shared folders and files: ids, names, owners, types). Open a shared folder with drive.list (folder_id), a file with drive.read.',
      auditClass: 'read',
      inputSchema: emptyInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        emptyInput.parse(input)
        return { items: await (await service()).sharedWithMe(actorOf(ctx)) }
      },
    },
    {
      name: 'drive.read',
      module: DRIVE_MODULE_ID,
      summary: 'Read a file from Drive as text by file_id: Markdown, CSV and plain text as they are; PDF, Word (.docx) and PowerPoint (.pptx) as their extracted text (an error says when a format cannot be read yet).',
      auditClass: 'read',
      inputSchema: readInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => (await service()).readText(actorOf(ctx), readInput.parse(input).file_id, { maxBytes: DRIVE_READ_MAX_BYTES }),
    },
    {
      name: 'drive.write_text',
      module: DRIVE_MODULE_ID,
      summary: 'Replace the text of a Markdown (.md) or table (.csv) file in Drive. Every write is kept as a revision that can be restored.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof writeInput>, output: unknown) => {
        const name = (output as { file?: { name?: string } } | undefined)?.file?.name
        return name ? `Saved a new version of ${name} in Drive` : `Tried to save file ${input.file_id} in Drive`
      },
      inputSchema: writeInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = writeInput.parse(input)
        const out = await (await service()).writeText(actorOf(ctx), i.file_id, i.content)
        return { file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
      },
    },
    {
      name: 'drive.create_document',
      module: DRIVE_MODULE_ID,
      summary:
        'Create a new Markdown (.md) document — or, with kind "csv", a table; with kind "xlsx", an empty Excel spreadsheet with one sheet "Sheet1" (no content: write its cells with drive.sheet_write) — in Drive (name; content, omit for an empty file; folder_id, omit for the top level). This is where the company’s internal documents go — pitch decks, project descriptions, funding/investor documents, plans, briefs, meeting notes — never the public website. Working for a person, it lands in their Drive as theirs. Revise it later with drive.write_text.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof createInput>, output: unknown) => {
        const name = (output as { file?: { name?: string } } | undefined)?.file?.name
        return name ? `Created ${name} in Drive` : `Tried to create ${input.name} in Drive`
      },
      inputSchema: createInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = createInput.parse(input)
        // A new document belongs to its creator: the person (also via the brain), in their own Drive.
        const file = await (await service()).createDocument(actorOf(ctx), i.folder_id ?? null, i.kind ?? 'md', i.name, i.content)
        return { file }
      },
    },
    {
      name: 'drive.archive',
      module: DRIVE_MODULE_ID,
      summary:
        'Archive Drive files or folders (items: [{ type: "file"|"folder", id }]): they leave the normal view but are not deleted — they stay where they are, still open, and show up in search and under Archived. Use it for what the person confirmed (e.g. from drive.suggest_archive). Each item is checked; the result says which could not be archived and why.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: unknown, output: unknown) => {
        const done = (output as { archived?: Array<{ name?: string }> } | undefined)?.archived ?? []
        return done.length === 1 ? `Archived ${done[0]!.name} in Drive` : `Archived ${done.length} items in Drive`
      },
      inputSchema: itemsInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => (await service()).archiveMany(actorOf(ctx), itemsInput.parse(input).items),
    },
    {
      name: 'drive.unarchive',
      module: DRIVE_MODULE_ID,
      summary:
        'Bring archived Drive files or folders back into the normal view (items: [{ type, id }], ids from drive.list_archived). Each item is checked; the result says which could not be and why, and names an archived folder an item still sits inside (stillIn).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (_input: unknown, output: unknown) => {
        const done = (output as { unarchived?: Array<{ name?: string }> } | undefined)?.unarchived ?? []
        return done.length === 1 ? `Brought ${done[0]!.name} back from the Drive archive` : `Brought ${done.length} items back from the Drive archive`
      },
      inputSchema: itemsInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const out = await (await service()).unarchiveMany(actorOf(ctx), itemsInput.parse(input).items)
        return { unarchived: out.unarchived.map((u) => ({ ...u.item, stillIn: u.stillIn })), errors: out.errors }
      },
    },
    {
      name: 'drive.list_archived',
      module: DRIVE_MODULE_ID,
      summary: 'List the archived Drive items you can open, grouped by the folder they are in: ids, names, when and by whom each was archived.',
      auditClass: 'read',
      inputSchema: emptyInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        emptyInput.parse(input)
        return { groups: await (await service()).archived(actorOf(ctx)) }
      },
    },
    {
      name: 'drive.suggest_archive',
      module: DRIVE_MODULE_ID,
      summary: `Suggest which Drive files could be archived: takes the files you can edit that have not changed for older_than_days (default ${SUGGEST_DEFAULT_DAYS}; ${SUGGEST_MIN_DAYS} to ${SUGGEST_MAX_DAYS}) and asks the AI which look done with, each with a one-line reason. Archives nothing: show the suggestions to the person and archive only what they confirm (drive.archive).`,
      auditClass: 'read',
      inputSchema: suggestInput,
      permission: { roles: DRIVE_ROLES },
      handler: async (ctx, input) => {
        const i = suggestInput.parse(input)
        const out = await suggestArchive(
          { drive: await service(), chat, ...(opts.now ? { now: opts.now } : {}) },
          { actor: actorOf(ctx), olderThanDays: i.older_than_days ?? SUGGEST_DEFAULT_DAYS },
        )
        return {
          older_than_days: out.olderThanDays,
          considered: out.considered,
          more: out.more,
          suggestions: out.suggestions.map((s) => ({
            type: 'file' as const,
            file_id: s.file.id,
            name: s.file.name,
            where: [s.root.label, ...s.path.map((c) => c.name)].join(' / '),
            last_changed: s.file.updatedAt,
            reason: s.reason,
          })),
        }
      },
    },
    {
      name: 'drive.app_status',
      module: DRIVE_MODULE_ID,
      summary:
        'Whether a Drive folder is a web app (its own package.json with a dev or start script, and which lockfile it has: webApp) and its app preview on this server, if any: state (installing, starting, running, failed, stopped), url, error and the last 200 log lines. Use the log to help fix a failing start. Reading it counts as someone looking (it keeps a running preview from stopping when idle). managed:false means this server does not run apps (no ee).',
      auditClass: 'read',
      inputSchema: folderInput,
      permission: { roles: ['admin', 'agent', 'member'] },
      handler: async (ctx, input) => appStatus(await appDeps(), actorOf(ctx), folderInput.parse(input).folder_id),
    },
    {
      name: 'drive.app_run',
      module: DRIVE_MODULE_ID,
      summary:
        'Run a Drive web app folder on this server (owner or admin, a person only — never the agent): copies the folder as it is now (without node_modules and .git), installs it from its lockfile and starts its dev script, at its own address. Running it again restarts it from a fresh copy. Only one app runs at a time.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof folderInput>, output: unknown) => {
        const name = (output as { preview?: { folderName?: string } } | undefined)?.preview?.folderName
        return name ? `Started the app in the Drive folder “${name}”` : `Tried to start the app in Drive folder ${input.folder_id}`
      },
      inputSchema: folderInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = await requireAppAdmin(ctx, 'drive.app_run', roleOf)
        return runApp(await appDeps(), actorOf(ctx), folderInput.parse(input).folder_id, author)
      },
    },
    {
      name: 'drive.app_stop',
      module: DRIVE_MODULE_ID,
      summary:
        'Stop a Drive folder’s app preview on this server and remove its copy (owner or admin, a person only). By folder_id, or by preview_id for the app another folder is running.',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof stopInput>, output: unknown) => {
        const name = (output as { preview?: { folderName?: string } } | undefined)?.preview?.folderName
        if (name) return `Stopped the app of the Drive folder “${name}”`
        return 'folder_id' in input ? `Tried to stop the app in Drive folder ${input.folder_id}` : `Tried to stop the app preview ${input.preview_id}`
      },
      inputSchema: stopInput,
      permission: { roles: ['admin'] },
      handler: async (ctx, input) => {
        const author = await requireAppAdmin(ctx, 'drive.app_stop', roleOf)
        const i = stopInput.parse(input)
        return stopApp(await appDeps(), 'folder_id' in i ? { actor: actorOf(ctx), folderId: i.folder_id } : { previewId: i.preview_id }, author)
      },
    },
    ...createDriveFileTools({ service }),
    ...createDrivePdfTools({ service }),
    ...createDrivePdfAnnotateTools({ service }),
    ...createDriveSheetTools({ service }),
    ...createDriveSheetFormatTools({ service }),
    ...createDriveSheetCopyTools({ service }),
    ...createDriveSheetArrangeTools({ service }),
    ...createDriveSheetPivotTableTools({ service }),
    ...createDriveSheetChartTools({ service }),
    ...createDriveSheetDrawingTools({ service }),
    ...createDriveSheetCommentTools({ service }),
    ...createDriveSheetEditingTools({
      service,
      ...(opts.pdfDeps ? { pdfDeps: opts.pdfDeps } : {}),
    }),
    ...createDriveSheetRulesTools({ service }),
  ]
}
