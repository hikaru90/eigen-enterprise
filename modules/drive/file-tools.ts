import type { DriveService } from './service'
import { z } from 'zod'
import type { ToolDescriptor } from '$lib/kernel/types'
import { grantsBody } from './http'
import { DRIVE_MODULE_ID } from './manifest'
import { DriveError, ON_CONFLICT } from './service'
import { actorOf } from './tools'

/**
 * Drive file management as registry tools (UI parity): everything the Drive
 * page's New / Upload / Rename / Move / Share / Trash / Versions controls do,
 * calling the same service functions the /api/drive routes call, as the
 * calling principal with their own access. Byte content travels as base64;
 * the service enforces the same upload size limit the route does.
 */

const DRIVE_ROLES = ['admin', 'member', 'agent']
const itemRef = { type: z.enum(['file', 'folder']), id: z.string().min(1) }
const itemInput = z.object(itemRef).strict()
const renameInput = z.object({ ...itemRef, name: z.string().trim().min(1) }).strict()
const moveInput = z.object({ ...itemRef, folder_id: z.string().min(1).nullable() }).strict()
const folderInput = z.object({ name: z.string().trim().min(1), parent_id: z.string().min(1).nullable().optional() }).strict()
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/
const base64 = z.string().regex(BASE64, 'content_base64 must be standard base64')
const uploadInput = z
  .object({
    name: z.string().trim().min(1),
    mime_type: z.string(),
    content_base64: base64,
    folder_id: z.string().min(1).nullable().optional(),
    on_conflict: z.enum(ON_CONFLICT, { message: 'on_conflict must be "replace", "keep_both" or "fail"' }),
  })
  .strict()
const bytesInput = z.object({ file_id: z.string().min(1), content_base64: base64 }).strict()
const fileInput = z.object({ file_id: z.string().min(1) }).strict()
const restoreRevisionInput = z.object({ file_id: z.string().min(1), revision_id: z.string().min(1) }).strict()
const sharingInput = z.object({ ...itemRef, grants: grantsBody.shape.grants }).strict()
const emptyInput = z.object({}).strict()

function decode(b64: string): Uint8Array {
  if (!BASE64.test(b64)) throw new DriveError('invalid', 'content_base64 must be standard base64.')
  return new Uint8Array(Buffer.from(b64, 'base64'))
}

const named = (output: unknown, key: 'item' | 'file' | 'folder') => (output as Record<string, { name?: string } | undefined> | undefined)?.[key]?.name

export function createDriveFileTools(deps: { service: () => Promise<DriveService> }): ToolDescriptor[] {
  const { service } = deps
  const write = { auditClass: 'mutate' as const, approvalRisk: 'internal' as const, permission: { roles: DRIVE_ROLES } }
  return [
    {
      name: 'drive.create_folder',
      module: DRIVE_MODULE_ID,
      summary: 'Create a folder in Drive (name; parent_id, omit for the top level).',
      ...write,
      activity: (i: z.infer<typeof folderInput>, o: unknown) => `Created the folder ${named(o, 'folder') ?? i.name} in Drive`,
      inputSchema: folderInput,
      handler: async (ctx, input) => {
        const i = folderInput.parse(input)
        return { folder: await (await service()).createFolder(actorOf(ctx), i.parent_id ?? null, i.name) }
      },
    },
    {
      name: 'drive.upload',
      module: DRIVE_MODULE_ID,
      summary:
        'Upload a file to Drive: name, mime_type, content_base64 (the bytes, base64), folder_id (omit for the top level), on_conflict — when a file of that exact name is already in the folder: "replace" (it gets the upload as a new revision; the old version stays restorable), "keep_both" (the upload is added as “name (2).ext”) or "fail" (refused with a conflict naming the existing file). Same size limit as uploading in the app.',
      ...write,
      activity: (i: z.infer<typeof uploadInput>, o: unknown) =>
        (o as { outcome?: string } | undefined)?.outcome === 'replaced'
          ? `Replaced ${named(o, 'file') ?? i.name} in Drive with an upload (a new version)`
          : `Uploaded ${named(o, 'file') ?? i.name} to Drive`,
      inputSchema: uploadInput,
      handler: async (ctx, input) => {
        const i = uploadInput.parse(input)
        const { outcome, ...file } = await (await service()).upload(
          actorOf(ctx),
          i.folder_id ?? null,
          { name: i.name, bytes: decode(i.content_base64), mime: i.mime_type },
          i.on_conflict,
        )
        return { file, outcome }
      },
    },
    {
      name: 'drive.save_file_bytes',
      module: DRIVE_MODULE_ID,
      summary: 'Save new bytes (content_base64) into an existing Drive file, e.g. a PDF, Word or PowerPoint file, as a new revision. Refused while someone holds the file’s edit lock.',
      ...write,
      activity: (i: z.infer<typeof bytesInput>, o: unknown) => `Saved a new version of ${named(o, 'file') ?? `file ${i.file_id}`} in Drive`,
      inputSchema: bytesInput,
      handler: async (ctx, input) => {
        const i = bytesInput.parse(input)
        const out = await (await service()).writeBytes(actorOf(ctx), i.file_id, decode(i.content_base64))
        return { file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
      },
    },
    {
      name: 'drive.list_revisions',
      module: DRIVE_MODULE_ID,
      summary: 'List a Drive file’s revisions (file_id), newest first: ids, times, authors, sizes. Restore one with drive.restore_revision.',
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: fileInput,
      handler: async (ctx, input) => ({ revisions: await (await service()).listRevisions(actorOf(ctx), fileInput.parse(input).file_id) }),
    },
    {
      name: 'drive.restore_revision',
      module: DRIVE_MODULE_ID,
      summary: 'Restore an earlier revision of a Drive file (file_id, revision_id from drive.list_revisions): saved again as the newest revision; nothing is lost.',
      ...write,
      activity: (i: z.infer<typeof restoreRevisionInput>, o: unknown) => `Restored an earlier version of ${named(o, 'file') ?? `file ${i.file_id}`} in Drive`,
      inputSchema: restoreRevisionInput,
      handler: async (ctx, input) => {
        const i = restoreRevisionInput.parse(input)
        const out = await (await service()).restoreRevision(actorOf(ctx), i.file_id, i.revision_id)
        return { file: out.file, revision: { id: out.revision.id, createdAt: out.revision.createdAt } }
      },
    },
    {
      name: 'drive.rename',
      module: DRIVE_MODULE_ID,
      summary: 'Rename a Drive file or folder (type, id, name).',
      ...write,
      activity: (i: z.infer<typeof renameInput>) => `Renamed a ${i.type} in Drive to ${i.name}`,
      inputSchema: renameInput,
      handler: async (ctx, input) => {
        const i = renameInput.parse(input)
        return { item: await (await service()).rename(actorOf(ctx), i.type, i.id, i.name) }
      },
    },
    {
      name: 'drive.move',
      module: DRIVE_MODULE_ID,
      summary: 'Move a Drive file or folder (type, id) into another folder (folder_id; null for the top level).',
      ...write,
      activity: (i: z.infer<typeof moveInput>, o: unknown) => `Moved ${named(o, 'item') ?? `${i.type} ${i.id}`} in Drive`,
      inputSchema: moveInput,
      handler: async (ctx, input) => {
        const i = moveInput.parse(input)
        return { item: await (await service()).move(actorOf(ctx), i.type, i.id, i.folder_id) }
      },
    },
    {
      name: 'drive.trash',
      module: DRIVE_MODULE_ID,
      summary: 'Move a Drive file or folder (type, id) to the trash. It can be restored (drive.restore) until it is deleted forever.',
      ...write,
      activity: (i: z.infer<typeof itemInput>) => `Moved ${i.type} ${i.id} to the Drive trash`,
      inputSchema: itemInput,
      handler: async (ctx, input) => {
        const i = itemInput.parse(input)
        await (await service()).moveToTrash(actorOf(ctx), i.type, i.id)
        return { ok: true }
      },
    },
    {
      name: 'drive.list_trash',
      module: DRIVE_MODULE_ID,
      summary: 'List the Drive trash: the trashed files and folders you can change, newest first.',
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: emptyInput,
      handler: async (ctx, input) => {
        emptyInput.parse(input)
        return { items: await (await service()).trash(actorOf(ctx)) }
      },
    },
    {
      name: 'drive.restore',
      module: DRIVE_MODULE_ID,
      summary: 'Restore a Drive file or folder (type, id) from the trash; to the top level when its folder is itself in the trash.',
      ...write,
      activity: (i: z.infer<typeof itemInput>, o: unknown) => `Restored ${named(o, 'item') ?? `${i.type} ${i.id}`} from the Drive trash`,
      inputSchema: itemInput,
      handler: async (ctx, input) => {
        const i = itemInput.parse(input)
        return { item: await (await service()).restore(actorOf(ctx), i.type, i.id) }
      },
    },
    {
      name: 'drive.delete_forever',
      module: DRIVE_MODULE_ID,
      summary: 'Delete a trashed Drive file or folder (type, id) and everything in it for good. Cannot be undone; needs manage access.',
      auditClass: 'mutate',
      approvalRisk: 'destructive',
      permission: { roles: DRIVE_ROLES },
      activity: (i: z.infer<typeof itemInput>) => `Deleted ${i.type} ${i.id} from Drive forever`,
      inputSchema: itemInput,
      handler: async (ctx, input) => {
        const i = itemInput.parse(input)
        await (await service()).deleteForever(actorOf(ctx), i.type, i.id)
        return { ok: true }
      },
    },
    {
      name: 'drive.get_sharing',
      module: DRIVE_MODULE_ID,
      summary: 'Who may open or edit a Drive file or folder (type, id): its direct grants (needs manage access).',
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: itemInput,
      handler: async (ctx, input) => {
        const i = itemInput.parse(input)
        return { grants: await (await service()).getGrants(actorOf(ctx), i.type, i.id) }
      },
    },
    {
      name: 'drive.set_sharing',
      module: DRIVE_MODULE_ID,
      summary:
        'Share a Drive file or folder: replace its direct grants (type, id, grants: [{ subject: { kind: "user", userId } | { kind: "group", groupId } | { kind: "company" }, level: "view"|"edit"|"manage" }]). Needs manage access.',
      ...write,
      activity: (i: z.infer<typeof sharingInput>) => `Changed who may open ${i.type} ${i.id} in Drive`,
      inputSchema: sharingInput,
      handler: async (ctx, input) => {
        const i = sharingInput.parse(input)
        return { grants: await (await service()).setGrants(actorOf(ctx), i.type, i.id, i.grants) }
      },
    },
  ]
}
