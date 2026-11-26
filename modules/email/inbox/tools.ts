import type { SendDeps } from './send'
import type { InboxDeps, MailboxView } from './service'
import type { AttachmentRow, MessageRow } from './store'
import { z } from 'zod'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { EMAIL_MODULE_ID } from '../manifest'
import { InboxError } from './errors'
import { sendMail } from './send'
import {
  addAlias,
  assignPersonalMailbox,
  createLabel,
  createSharedMailbox,
  deleteLabel,
  folderCounts,
  getThread,
  listFolder,
  listLabels,
  mailboxAdmin,
  moveMessage,
  readableMailboxes,
  removeAlias,
  setMailboxDisabled,
  changeMailboxAddress,
  deleteMailbox,
  setMessageLabel,
  setRead,
  setStarred,
} from './service'
import { COMPOSE_MODES, FOLDERS, LABEL_COLORS, LIST_FILTERS, LIST_SORTS, MOVE_TARGETS } from './types'

/**
 * The inbox as kernel tools (parity with Email › Inbox and Setup › Mailboxes):
 * every handler calls the same service function the page's form action calls,
 * as the calling principal — the inbox service's access rule decides (a
 * mailbox or mail the caller doesn't read is "not found"; administration is
 * owner/admin only). An agent principal that is no member reads no mailbox.
 */

export type InboxToolDeps = {
  inbox?: () => Promise<InboxDeps>
  send?: () => Promise<SendDeps>
  /** The SES receipt-rule sync after a mailbox change: null, or Amazon's reason. */
  syncReceiving?: () => Promise<string | null>
  /** Email › Logs › Cancel: a scheduled company mail. */
  cancelScheduled?: (id: string) => Promise<void>
}

const ROLES = { roles: ['admin', 'member', 'agent'] }
const ADMIN_ROLES = { roles: ['admin', 'agent'] }

const id = (what: string) => z.uuid().describe(what)
const mailboxId = id('the mailbox id (email.mailbox_list)')
const messageId = id('the mail id (email.mail_list)')
const domainId = z.string().min(1).describe('a verified domain id (email.mailbox_admin domains)')
const localPart = z.string().min(1).describe('the part before the @')
const displayName = z.string().max(120).nullable().optional().describe('the name recipients see')

const empty = z.object({}).strict()
const listInput = z
  .object({
    mailboxId,
    folder: z.enum(FOLDERS).optional().describe('one folder; omit when using starred or labelId'),
    starred: z.literal(true).optional().describe('Starred: across folders but Spam and Trash'),
    labelId: z.uuid().optional().describe('one label: across folders but Spam and Trash'),
    search: z.string().optional().describe('a literal substring of subject, sender or snippet'),
    filter: z.enum(LIST_FILTERS).optional(),
    sort: z.enum(LIST_SORTS).optional(),
  })
  .strict()
const readInput = z.object({ messageId }).strict()
const mineInput = z.object({ localPart, domainId }).strict()
const assignInput = z.object({ memberId: z.string().min(1), localPart, domainId, displayName }).strict()
const sharedInput = z.object({ groupId: z.string().min(1), localPart, domainId, displayName }).strict()
const disabledInput = z.object({ mailboxId, disabled: z.boolean() }).strict()
const aliasInput = z.object({ mailboxId, localPart, domainId }).strict()
const removeAliasInput = z.object({ address: z.string().min(3) }).strict()
const setAddressInput = z.object({ mailboxId, localPart, domainId }).strict()
const deleteMailboxInput = z.object({ mailboxId }).strict()
const labelCreateInput = z.object({ mailboxId, name: z.string().min(1), color: z.enum(LABEL_COLORS) }).strict()
const labelDeleteInput = z.object({ labelId: z.uuid() }).strict()
const mailLabelInput = z.object({ messageId, labelId: z.uuid(), on: z.boolean().describe('true puts it on, false takes it off') }).strict()
const moveInput = z.object({ messageId, folder: z.enum(MOVE_TARGETS).describe('archive, trash, spam, or back to the inbox') }).strict()
const markReadInput = z.object({ messageId, read: z.boolean() }).strict()
const starInput = z.object({ messageId, starred: z.boolean() }).strict()
const attachment = z
  .object({
    filename: z.string().min(1),
    contentType: z.string().min(1).describe('the mime type'),
    contentBase64: z.base64().describe('the file bytes, base64'),
  })
  .strict()
const sendInput = z
  .object({
    mailboxId: id('the mailbox to send from (one you read)'),
    mode: z.enum(COMPOSE_MODES).default('new'),
    parentId: z.uuid().optional().describe('the mail replied to or forwarded (required unless mode is new)'),
    to: z.string().describe('comma-separated recipients, as typed in the To field'),
    cc: z.string().default(''),
    bcc: z.string().default(''),
    subject: z.string(),
    body: z.string().describe('plain text'),
    attachments: z.array(attachment).default([]).describe('same size limits as the compose form'),
  })
  .strict()
const cancelInput = z.object({ id: z.uuid().describe('the scheduled mail (email.log_list)') }).strict()

function mailboxOut(b: MailboxView) {
  return { id: b.id, address: b.address, aliases: b.aliases, kind: b.kind, displayName: b.displayName, disabled: b.disabled }
}

function attachmentOut(a: AttachmentRow) {
  return { id: a.id, filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes, blocked: a.blocked }
}

function mailOut(m: MessageRow, attachments: AttachmentRow[]) {
  return {
    id: m.id,
    mailboxId: m.mailboxId,
    folder: m.folder,
    threadId: m.threadId,
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    receivedAt: m.receivedAt.toISOString(),
    read: m.readAt !== null,
    starred: m.starred,
    textBody: m.textBody,
    htmlBody: m.textBody === null ? m.htmlBody : null,
    attachments: attachments.map(attachmentOut),
  }
}

async function liveInbox(): Promise<InboxDeps> {
  const { inboxDeps } = await import('./live')
  return inboxDeps()
}
async function liveSend(): Promise<SendDeps> {
  const { sendDeps } = await import('./live')
  return sendDeps()
}
async function liveSync(): Promise<string | null> {
  const { syncMailReceiving } = await import('../platform/receiving-sync')
  return syncMailReceiving()
}
async function liveCancel(logId: string): Promise<void> {
  const { emailPlatform } = await import('../platform/service')
  await emailPlatform().cancelScheduled(logId)
}

/** The person the call acts as: the principal itself (a member, or an agent key that is one). */
const actor = (ctx: ToolContext) => ctx.principal.id

export function createInboxTools(opts: InboxToolDeps = {}): ToolDescriptor[] {
  const inbox = opts.inbox ?? liveInbox
  const send = opts.send ?? liveSend
  const sync = opts.syncReceiving ?? liveSync
  const cancel = opts.cancelScheduled ?? liveCancel

  /** As the mailbox pages: a failed receipt-rule sync keeps the change and reports Amazon's reason. */
  const synced = async <T extends object>(out: T) => {
    const receivingError = await sync()
    return receivingError === null ? out : { ...out, receivingError }
  }

  const write = (
    name: string,
    summary: string,
    inputSchema: z.ZodType,
    activity: (input: never) => string,
    handler: (ctx: ToolContext, input: never) => Promise<unknown>,
    over: Partial<ToolDescriptor> = {},
  ): ToolDescriptor => ({
    name,
    module: EMAIL_MODULE_ID,
    summary,
    auditClass: 'mutate',
    approvalRisk: 'internal',
    inputSchema,
    permission: ROLES,
    activity: activity as ToolDescriptor['activity'],
    handler: (ctx, input) => handler(ctx, inputSchema.parse(input) as never),
    ...over,
  })

  const read = (name: string, summary: string, inputSchema: z.ZodType, handler: (ctx: ToolContext, input: never) => Promise<unknown>, permission = ROLES): ToolDescriptor => ({
    name,
    module: EMAIL_MODULE_ID,
    summary,
    auditClass: 'read',
    inputSchema,
    permission,
    handler: (ctx, input) => handler(ctx, inputSchema.parse(input) as never),
  })

  return [
    read('email.mailbox_list', 'The mailboxes you read (your personal one, shared ones of your groups), with folder counts.', empty, async (ctx) => {
      const deps = await inbox()
      const boxes = await readableMailboxes(deps, actor(ctx))
      return {
        mailboxes: await Promise.all(boxes.map(async (b) => ({ ...mailboxOut(b), folders: await folderCounts(deps, actor(ctx), b.id) }))),
      }
    }),
    read(
      'email.mailbox_admin',
      'Setup › Mailboxes (owner/admin): every mailbox with holder and counts (no mail content), members with their mailbox, groups, and the verified domains to create addresses on.',
      empty,
      async (ctx) => mailboxAdmin(await inbox(), actor(ctx)),
      ADMIN_ROLES,
    ),
    read(
      'email.mail_list',
      'List mail in a mailbox you read: one folder, Starred, or a label; optional search, filter (unread, attachments) and sort. Up to 100, newest first. Also returns the mailbox labels.',
      listInput,
      async (ctx, input: z.infer<typeof listInput>) => {
        const deps = await inbox()
        const messages = await listFolder(deps, actor(ctx), {
          mailboxId: input.mailboxId,
          ...(input.folder ? { folder: input.folder } : {}),
          ...(input.starred ? { view: 'starred' as const } : {}),
          ...(input.labelId ? { labelId: input.labelId } : {}),
          search: input.search ?? null,
          filter: input.filter ?? null,
          sort: input.sort ?? null,
        })
        const labels = await listLabels(deps, actor(ctx), input.mailboxId)
        return {
          labels: labels.map((l) => ({ id: l.id, name: l.name, color: l.color })),
          messages: messages.map((m) => ({
            id: m.id,
            threadId: m.threadId,
            folder: m.folder,
            from: m.from,
            to: m.to,
            subject: m.subject,
            snippet: m.snippet,
            receivedAt: m.receivedAt.toISOString(),
            read: m.readAt !== null,
            starred: m.starred,
            labelIds: m.labelIds,
            hasAttachments: m.hasAttachments,
          })),
        }
      },
    ),
    read(
      'email.mail_read',
      'Read one mail and its whole thread in that mailbox (oldest first), bodies and attachment metadata. Does not mark it read (email.mail_mark_read does).',
      readInput,
      async (ctx, input: z.infer<typeof readInput>) => {
        const thread = await getThread(await inbox(), actor(ctx), input.messageId)
        return {
          messageId: thread.message.id,
          messages: thread.messages.map((m) => mailOut(m, thread.attachments.get(m.id) ?? [])),
        }
      },
    ),

    write(
      'email.mailbox_create_mine',
      'Owner/admin: create your own personal mailbox on a verified domain.',
      mineInput,
      (i: z.infer<typeof mineInput>) => `Created my mailbox ${i.localPart}`,
      async (ctx, i: z.infer<typeof mineInput>) =>
        synced(mailboxOut(await assignPersonalMailbox(await inbox(), actor(ctx), { memberId: actor(ctx), localPart: i.localPart, domainId: i.domainId }))),
      { permission: ADMIN_ROLES },
    ),
    write(
      'email.mailbox_assign',
      'Owner/admin: give a member their personal mailbox (one per member).',
      assignInput,
      (i: z.infer<typeof assignInput>) => `Gave member ${i.memberId} a mailbox`,
      async (ctx, i: z.infer<typeof assignInput>) =>
        synced(mailboxOut(await assignPersonalMailbox(await inbox(), actor(ctx), { ...i, displayName: i.displayName ?? null }))),
      { permission: ADMIN_ROLES },
    ),
    write(
      'email.mailbox_create_shared',
      'Owner/admin: create a shared mailbox (info@, sales@) read by one group.',
      sharedInput,
      (i: z.infer<typeof sharedInput>) => `Created the shared mailbox ${i.localPart}`,
      async (ctx, i: z.infer<typeof sharedInput>) =>
        synced(mailboxOut(await createSharedMailbox(await inbox(), actor(ctx), { ...i, displayName: i.displayName ?? null }))),
      { permission: ADMIN_ROLES },
    ),
    write(
      'email.mailbox_set_disabled',
      'Owner/admin: disable (receives no new mail; what it holds stays readable) or enable a mailbox.',
      disabledInput,
      (i: z.infer<typeof disabledInput>) => `${i.disabled ? 'Disabled' : 'Enabled'} a mailbox`,
      async (ctx, i: z.infer<typeof disabledInput>) => synced(mailboxOut(await setMailboxDisabled(await inbox(), actor(ctx), i))),
      { permission: ADMIN_ROLES },
    ),
    write(
      'email.mailbox_set_address',
      'Owner/admin: change a mailbox’s main address (e.g. fix a typo). The old main address stops receiving; an alias of the mailbox can be promoted. The mail stays.',
      setAddressInput,
      (i: z.infer<typeof setAddressInput>) => `Changed a mailbox’s address to ${i.localPart}`,
      async (ctx, i: z.infer<typeof setAddressInput>) => synced(mailboxOut(await changeMailboxAddress(await inbox(), actor(ctx), i))),
      { permission: ADMIN_ROLES },
    ),
    write(
      'email.mailbox_delete',
      'Owner/admin: delete a mailbox for good — its addresses stop receiving and all the mail in it is deleted.',
      deleteMailboxInput,
      () => 'Deleted a mailbox',
      async (ctx, i: z.infer<typeof deleteMailboxInput>) => {
        const out = await deleteMailbox(await inbox(), actor(ctx), i)
        return synced({ mailboxId: i.mailboxId, ...out, deleted: true })
      },
      { permission: ADMIN_ROLES, approvalRisk: 'destructive' },
    ),
    write(
      'email.mailbox_alias_add',
      'Owner/admin: add an alias address delivering into a mailbox.',
      aliasInput,
      (i: z.infer<typeof aliasInput>) => `Added the alias ${i.localPart} to a mailbox`,
      async (ctx, i: z.infer<typeof aliasInput>) => synced(mailboxOut(await addAlias(await inbox(), actor(ctx), i))),
      { permission: ADMIN_ROLES },
    ),
    write(
      'email.mailbox_alias_remove',
      'Owner/admin: remove an alias address (never a mailbox’s main address).',
      removeAliasInput,
      (i: z.infer<typeof removeAliasInput>) => `Removed the alias ${i.address}`,
      async (ctx, i: z.infer<typeof removeAliasInput>) => {
        await removeAlias(await inbox(), actor(ctx), i)
        return synced({ address: i.address, removed: true })
      },
      { permission: ADMIN_ROLES, approvalRisk: 'destructive' },
    ),
    write(
      'email.label_create',
      'Create a label in a mailbox you read.',
      labelCreateInput,
      (i: z.infer<typeof labelCreateInput>) => `Created the mail label ${i.name}`,
      async (ctx, i: z.infer<typeof labelCreateInput>) => {
        const l = await createLabel(await inbox(), actor(ctx), i)
        return { id: l.id, name: l.name, color: l.color }
      },
    ),
    write(
      'email.label_delete',
      'Delete a mailbox label (taken off every mail; the mail stays).',
      labelDeleteInput,
      () => 'Deleted a mail label',
      async (ctx, i: z.infer<typeof labelDeleteInput>) => {
        await deleteLabel(await inbox(), actor(ctx), i)
        return { labelId: i.labelId, deleted: true }
      },
      { approvalRisk: 'destructive' },
    ),
    write(
      'email.mail_label',
      'Put a label on a mail or take it off.',
      mailLabelInput,
      (i: z.infer<typeof mailLabelInput>) => (i.on ? 'Labelled a mail' : 'Took a label off a mail'),
      async (ctx, i: z.infer<typeof mailLabelInput>) => {
        await setMessageLabel(await inbox(), actor(ctx), i)
        return { messageId: i.messageId, labelId: i.labelId, on: i.on }
      },
    ),
    write(
      'email.mail_move',
      'Move a mail: archive, trash, spam, or back to the inbox. Nothing is deleted for good.',
      moveInput,
      (i: z.infer<typeof moveInput>) => `Moved a mail to ${i.folder}`,
      async (ctx, i: z.infer<typeof moveInput>) => {
        await moveMessage(await inbox(), actor(ctx), i)
        return { messageId: i.messageId, folder: i.folder }
      },
    ),
    write(
      'email.mail_mark_read',
      'Mark a mail read or unread.',
      markReadInput,
      (i: z.infer<typeof markReadInput>) => `Marked a mail ${i.read ? 'read' : 'unread'}`,
      async (ctx, i: z.infer<typeof markReadInput>) => {
        await setRead(await inbox(), actor(ctx), i)
        return { messageId: i.messageId, read: i.read }
      },
    ),
    write(
      'email.mail_star',
      'Star or unstar a mail.',
      starInput,
      (i: z.infer<typeof starInput>) => (i.starred ? 'Starred a mail' : 'Unstarred a mail'),
      async (ctx, i: z.infer<typeof starInput>) => {
        await setStarred(await inbox(), actor(ctx), i)
        return { messageId: i.messageId, starred: i.starred }
      },
    ),
    write(
      'email.mail_send',
      'Write, reply (all) or forward from a mailbox you read, with attachments (base64; the compose form’s limits). Not email.send_mail, the transactional sender.',
      sendInput,
      // Recipients only: subject and body stay out of the audit trail.
      (i: z.infer<typeof sendInput>) => `Sent a mail from a mailbox to ${i.to}`,
      async (ctx, i: z.infer<typeof sendInput>) => {
        if (i.mode !== 'new' && !i.parentId) throw new InboxError('invalid', 'Pick the mail to reply to or forward first.')
        return sendMail(await send(), actor(ctx), {
          mailboxId: i.mailboxId,
          mode: i.mode,
          parentId: i.parentId ?? null,
          to: i.to,
          cc: i.cc,
          bcc: i.bcc,
          subject: i.subject,
          body: i.body,
          uploads: i.attachments.map((a) => ({
            filename: a.filename,
            contentType: a.contentType,
            bytes: new Uint8Array(Buffer.from(a.contentBase64, 'base64')),
          })),
        })
      },
      { auditClass: 'external', approvalRisk: 'external' },
    ),
    write(
      'email.log_cancel',
      'Owner/admin: cancel a scheduled (queued) company mail from Email › Logs.',
      cancelInput,
      () => 'Cancelled a scheduled mail',
      async (_ctx, i: z.infer<typeof cancelInput>) => {
        await cancel(i.id)
        return { id: i.id, cancelled: true }
      },
      { permission: ADMIN_ROLES, approvalRisk: 'destructive' },
    ),
  ]
}
