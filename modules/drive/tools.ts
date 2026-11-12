import type { Actor, DriveService } from './service'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { liveSuggestChat, SUGGEST_DEFAULT_DAYS, SUGGEST_MAX_DAYS, SUGGEST_MIN_DAYS, suggestArchive, type SuggestChat } from './archive-suggest'
import { DRIVE_MODULE_ID } from './manifest'

/**
 * drive.* kernel tools: list a folder, read a text file, write a Markdown/CSV
 * file (a new revision), archive and unarchive, list the archive, and ask for
 * archive suggestions. Every call runs through the Drive service's access
 * checks as the calling principal: a person with their own access, the agent
 * with admin rights (like members.*). Writing, archiving and unarchiving are
 * mutate-class and wait on the company's approval mode; suggesting changes
 * nothing.
 */

export type DriveToolDeps = {
  service?: () => Promise<DriveService>
  /** The gateway call behind drive.suggest_archive (tests inject a fake). */
  chat?: SuggestChat
  now?: () => Date
}

/** Batch size for one archive/unarchive call (one approval). */
export const ARCHIVE_BATCH_MAX = 100

const listInput = z.object({ folder_id: z.string().min(1).nullable().optional() }).strict()
const readInput = z.object({ file_id: z.string().min(1) }).strict()
const writeInput = z.object({ file_id: z.string().min(1), content: z.string() }).strict()
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

export function actorOf(ctx: ToolContext): Actor {
  return ctx.principal.kind === 'human' ? { kind: 'user', userId: ctx.principal.id } : { kind: 'agent', id: ctx.principal.id }
}

async function liveService(): Promise<DriveService> {
  const { driveService } = await import('./index')
  return driveService()
}

export function createDriveTools(opts: DriveToolDeps = {}): ToolDescriptor[] {
  const service = opts.service ?? liveService
  const chat = opts.chat ?? liveSuggestChat
  return [
    {
      name: 'drive.list',
      module: DRIVE_MODULE_ID,
      summary:
        'List a Drive folder (folder_id; omit for the top level): its folders and files with ids, names, sizes and types. Archived items are left out (drive.list_archived lists them).',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const out = await (await service()).listFolder(actorOf(ctx), i.folder_id ?? null)
        return { folder: out.folder, path: out.path, items: out.items }
      },
    },
    {
      name: 'drive.read',
      module: DRIVE_MODULE_ID,
      summary: 'Read a text file from Drive (Markdown, CSV, plain text) by file_id.',
      auditClass: 'read',
      inputSchema: readInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => (await service()).readText(actorOf(ctx), readInput.parse(input).file_id),
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
      permission: { roles: ['admin', 'agent'] },
      handler: async (ctx, input) => {
        const i = writeInput.parse(input)
        const out = await (await service()).writeText(actorOf(ctx), i.file_id, i.content)
        return { file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
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
      permission: { roles: ['admin', 'agent'] },
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
      permission: { roles: ['admin', 'agent'] },
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
      permission: { roles: ['admin', 'agent'] },
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
      permission: { roles: ['admin', 'agent'] },
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
  ]
}
