import { z } from 'zod'
import { actsAsMember } from '$lib/kernel/principals'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import type { Member } from '$lib/office/xlsx/threads'
import { DRIVE_MODULE_ID } from './manifest'
import { DriveError, type DriveService } from './service'
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
} from './sheet-tools'

/**
 * drive.sheet_comment_* — list, add, reply to, edit, resolve/reopen, and
 * delete Excel threaded comments (with company member @mentions mapped to
 * persons) and legacy cell notes (src/lib/office/xlsx/{threads,notes}.ts).
 */

const commentText = z.string().min(1).max(32_767)
const commentId = z.string().min(1).describe('The comment or reply id')
const threadId = z.string().min(1).describe('The comment thread id (its first comment’s id)')
const mentionsList = z
  .array(z.string().min(1))
  .max(50)
  .optional()
  .describe('Company member ids to @mention (mapped to the workbook’s persons list)')

const listInput = z
  .object({
    file_id: fileId,
    sheet: sheetName.optional().describe('The sheet to list; omitted: the first visible sheet'),
  })
  .strict()

const addInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    cell: cellRef,
    kind: z.enum(['comment', 'note']).default('comment').describe('comment: threaded Excel comment; note: legacy sticky note'),
    text: commentText,
    visible: z.boolean().optional().describe('Notes only: keep the yellow note box shown all the time'),
    mentions: mentionsList,
  })
  .strict()

const replyInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    thread: threadId,
    text: commentText,
    mentions: mentionsList,
  })
  .strict()

const editInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    id: commentId.optional().describe('Threaded comment or reply id to edit'),
    cell: cellRef.optional().describe('Cell address of a legacy note to edit'),
    text: commentText.optional(),
    visible: z.boolean().optional().describe('Notes only: toggle always-visible state'),
    mentions: mentionsList,
  })
  .strict()

const resolveInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    thread: threadId,
    resolved: z.boolean().default(true).describe('true to resolve, false to reopen'),
  })
  .strict()

const deleteInput = z
  .object({
    file_id: fileId,
    sheet: sheetName,
    id: commentId.optional().describe('Threaded comment or reply id to delete (deleting the first comment removes the thread)'),
    cell: cellRef.optional().describe('Cell address of a legacy note to delete'),
  })
  .strict()

async function memberOf(drive: DriveService, ctx: ToolContext): Promise<Member> {
  if (!actsAsMember(ctx.principal)) {
    throw new DriveError(
      'forbidden',
      'Comments and notes must belong to a company member; this call has no member identity.',
    )
  }
  const person = (await drive.shareTargets()).people.find((p) => p.id === ctx.principal.id)
  const name = person ? person.name || person.email : ''
  if (!name) {
    throw new DriveError(
      'forbidden',
      'Comments and notes record the member’s name, and this member is missing from Drive share targets.',
    )
  }
  return { id: ctx.principal.id, name }
}

async function resolveMentions(drive: DriveService, ids: string[] | undefined): Promise<Member[]> {
  if (!ids || ids.length === 0) return []
  const people = new Map((await drive.shareTargets()).people.map((p) => [p.id, p]))
  const out: Member[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    const p = people.get(id)
    if (!p) throw new DriveError('invalid', `No company member with id “${id}” to mention.`)
    out.push({ id: p.id, name: p.name || p.email })
  }
  return out
}

export function createDriveSheetCommentTools({ service, sheetLive }: DriveSheetToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'drive.sheet_comment_list',
      module: DRIVE_MODULE_ID,
      summary:
        'List all threaded comments (with replies, resolved state, and @mentions) and legacy notes on an Excel worksheet.',
      auditClass: 'read',
      permission: { roles: DRIVE_ROLES },
      inputSchema: listInput,
      handler: async (ctx, input) => {
        const i = listInput.parse(input)
        const lib = await xlsx()
        const { file, editor } = await openBook(await service(), ctx, i.file_id, lib, sheetLive)
        return guarded(lib, () => {
          const sheet =
            i.sheet ??
            editor.wb.sheets().find((s) => s.kind === 'worksheet' && s.state === 'visible')?.name
          if (!sheet) return { file: { id: file.id, name: file.name }, sheet: null, notes: [], comments: [] }
          const data = editor.wb.sheet(sheet)
          const ann = lib.read.readSheetAnnotations(editor, data.info.name)
          return {
            file: { id: file.id, name: file.name },
            sheet: data.info.name,
            notes: ann.notes,
            comments: ann.comments,
          }
        })
      },
    },
    {
      name: 'drive.sheet_comment_add',
      module: DRIVE_MODULE_ID,
      summary:
        'Add a threaded comment (kind "comment", default, with optional company member @mentions) or a legacy cell note (kind "note", with optional visible flag) on a worksheet cell.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof addInput>, output: unknown) => {
        const name = nameOf(output)
        const what = input.kind === 'note' ? 'a note' : 'a comment'
        return name
          ? `Added ${what} at ${input.cell} in ${input.sheet} of ${name} in Drive`
          : `Tried to add a comment in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: addInput,
      handler: async (ctx, input) => {
        const i = addInput.parse(input)
        if (i.kind === 'note' && i.mentions?.length)
          throw new DriveError('invalid', 'Legacy notes do not support @mentions; use kind "comment".')
        if (i.kind === 'comment' && i.visible !== undefined)
          throw new DriveError('invalid', 'Only legacy notes have the visible (Show Note) toggle.')
        const drive = await service()
        const [author, mentions, lib] = await Promise.all([
          memberOf(drive, ctx),
          i.kind === 'comment' ? resolveMentions(drive, i.mentions) : Promise.resolve([]),
          xlsx(),
        ])
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const res = await guarded(lib, () => {
          if (i.kind === 'note') {
            return editor.apply({
              op: 'set_note',
              sheet: i.sheet,
              ref: i.cell,
              text: i.text,
              author: author.name,
              visible: i.visible,
            })
          }
          return editor.apply({
            op: 'add_comment',
            sheet: i.sheet,
            ref: i.cell,
            text: i.text,
            author,
            mentions,
          })
        })
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return {
          ...saved,
          sheet: res.sheets[0]!,
          kind: i.kind,
          cell: i.cell.toUpperCase().replace(/\$/g, ''),
          ...(res.created ? { id: res.created } : {}),
        }
      },
    },
    {
      name: 'drive.sheet_comment_reply',
      module: DRIVE_MODULE_ID,
      summary: 'Reply to a threaded comment on an Excel worksheet, with optional company member @mentions.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof replyInput>, output: unknown) => {
        const name = nameOf(output)
        return name
          ? `Replied to comment thread in ${input.sheet} of ${name} in Drive`
          : `Tried to reply to a comment in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: replyInput,
      handler: async (ctx, input) => {
        const i = replyInput.parse(input)
        const drive = await service()
        const [author, mentions, lib] = await Promise.all([
          memberOf(drive, ctx),
          resolveMentions(drive, i.mentions),
          xlsx(),
        ])
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const res = await guarded(lib, () =>
          editor.apply({
            op: 'reply_comment',
            sheet: i.sheet,
            thread: i.thread,
            text: i.text,
            author,
            mentions,
          }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: res.sheets[0]!, thread: i.thread, id: res.created! }
      },
    },
    {
      name: 'drive.sheet_comment_edit',
      module: DRIVE_MODULE_ID,
      summary:
        'Edit a threaded comment or reply (by id, as its author) or edit a legacy note’s text or Show Note visibility (by cell).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof editInput>, output: unknown) => {
        const name = nameOf(output)
        const target = input.cell ? `note at ${input.cell}` : 'comment'
        return name
          ? `Edited ${target} in ${input.sheet} of ${name} in Drive`
          : `Tried to edit a comment in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: editInput,
      handler: async (ctx, input) => {
        const i = editInput.parse(input)
        if ((i.id ? 1 : 0) + (i.cell ? 1 : 0) !== 1)
          throw new DriveError('invalid', 'Give either id (for a comment/reply) or cell (for a note), not both.')
        const drive = await service()
        const lib = await xlsx()
        if (i.id) {
          if (i.text === undefined) throw new DriveError('invalid', 'Give the new comment text.')
          if (i.visible !== undefined) throw new DriveError('invalid', 'Only legacy notes have the visible toggle.')
          const [author, mentions] = await Promise.all([
            memberOf(drive, ctx),
            resolveMentions(drive, i.mentions),
          ])
          const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
          const res = await guarded(lib, () =>
            editor.apply({
              op: 'edit_comment',
              sheet: i.sheet,
              id: i.id!,
              text: i.text!,
              author,
              mentions,
            }),
          )
          const saved = await save(drive, ctx, i.file_id, editor, base)
          return { ...saved, sheet: res.sheets[0]!, id: i.id! }
        }
        if (i.mentions?.length)
          throw new DriveError('invalid', 'Legacy notes do not support @mentions.')
        if (i.text === undefined && i.visible === undefined)
          throw new DriveError('invalid', 'Give text or visible to update the note.')
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const res = await guarded(lib, () =>
          editor.apply({
            op: 'set_note',
            sheet: i.sheet,
            ref: i.cell!,
            text: i.text,
            visible: i.visible,
          }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: res.sheets[0]!, cell: i.cell!.toUpperCase().replace(/\$/g, '') }
      },
    },
    {
      name: 'drive.sheet_comment_resolve',
      module: DRIVE_MODULE_ID,
      summary: 'Resolve or reopen a threaded comment on an Excel worksheet.',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof resolveInput>, output: unknown) => {
        const name = nameOf(output)
        const verb = input.resolved ? 'Resolved' : 'Reopened'
        return name
          ? `${verb} comment thread in ${input.sheet} of ${name} in Drive`
          : `Tried to update a comment thread in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: resolveInput,
      handler: async (ctx, input) => {
        const i = resolveInput.parse(input)
        const drive = await service()
        const lib = await xlsx()
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const res = await guarded(lib, () =>
          editor.apply({
            op: 'resolve_comment',
            sheet: i.sheet,
            thread: i.thread,
            resolved: i.resolved,
          }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return { ...saved, sheet: res.sheets[0]!, thread: i.thread, resolved: i.resolved }
      },
    },
    {
      name: 'drive.sheet_comment_delete',
      module: DRIVE_MODULE_ID,
      summary:
        'Delete a threaded comment or reply (by id; deleting the first comment removes the whole thread) or a legacy cell note (by cell).',
      auditClass: 'mutate',
      approvalRisk: 'internal',
      activity: (input: z.infer<typeof deleteInput>, output: unknown) => {
        const name = nameOf(output)
        const what = input.cell ? `note at ${input.cell}` : `comment ${input.id}`
        return name
          ? `Deleted ${what} in ${input.sheet} of ${name} in Drive`
          : `Tried to delete a comment in file ${input.file_id} in Drive`
      },
      permission: { roles: DRIVE_ROLES },
      inputSchema: deleteInput,
      handler: async (ctx, input) => {
        const i = deleteInput.parse(input)
        if ((i.id ? 1 : 0) + (i.cell ? 1 : 0) !== 1)
          throw new DriveError('invalid', 'Give either id (for a comment/reply) or cell (for a note), not both.')
        const drive = await service()
        const lib = await xlsx()
        if (i.id) {
          const author = await memberOf(drive, ctx)
          const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
          const res = await guarded(lib, () =>
            editor.apply({ op: 'delete_comment', sheet: i.sheet, id: i.id!, author }),
          )
          const saved = await save(drive, ctx, i.file_id, editor, base)
          return { ...saved, sheet: res.sheets[0]!, deleted: i.id! }
        }
        const { editor, base } = await openBook(drive, ctx, i.file_id, lib, sheetLive)
        const res = await guarded(lib, () =>
          editor.apply({ op: 'delete_note', sheet: i.sheet, ref: i.cell! }),
        )
        const saved = await save(drive, ctx, i.file_id, editor, base)
        return {
          ...saved,
          sheet: res.sheets[0]!,
          deleted: i.cell!.toUpperCase().replace(/\$/g, ''),
        }
      },
    },
  ]
}
