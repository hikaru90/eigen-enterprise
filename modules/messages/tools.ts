import type { Conversation } from './store'
import { z } from 'zod'
import { actsAsMember } from '$lib/kernel/principals'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'
import { MESSAGES_MODULE_ID } from './manifest'
import {
  presenceFor,
  setDoNotDisturb,
  setShareWhere,
  type CoworkerPresencePort,
  type PresencePort,
  type ShareWherePort,
  type WhereDrivePort,
} from './presence'
import {
  conversationMembers,
  createChannel,
  deleteMessage,
  editMessage,
  listConversations,
  listMessages,
  listThread,
  markRead,
  MessagesError,
  messagePage,
  openDm,
  postMessage,
  toggleReaction,
  uploadAttachments,
  type MessageDto,
  type MessagesDeps,
} from './service'

/**
 * messages.* kernel tools. A person reads what they may see (their channels
 * and their DMs) and writes exactly as /api/messages/* does — the same service
 * calls, the same push fan-out. An AI co-worker (plan/phase-ai-coworkers.md C3)
 * takes part like a member, with its own access: it reads, posts, replies in
 * threads, reacts, opens DMs and marks read in the conversations it may use —
 * but creates no channel, uploads nothing, edits or deletes nothing, and never
 * moderates (MEMBER_TOOLS lists what it reaches). Any other principal (the
 * agent) reads only what the whole company may see: channels with a company
 * grant; never private channels or DMs; and never writes (owner decision W-2).
 */

type PushFn = (d: MessagesDeps, c: Conversation, m: MessageDto) => void

const listInput = z.object({}).strict()
const readInput = z
  .object({
    conversation_id: z.string().uuid().optional(),
    channel: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    before_id: z.string().uuid().optional(),
  })
  .strict()
  .refine((i) => (i.conversation_id ? 1 : 0) + (i.channel ? 1 : 0) === 1, {
    message: 'pass exactly one of conversation_id or channel',
  })

const uuid = z.string().uuid()
const messageInput = z.object({ message_id: uuid }).strict()
const conversationInput = z.object({ conversation_id: uuid }).strict()
const createChannelInput = z
  .object({
    name: z.string().min(1),
    topic: z.string().optional(),
    private: z.boolean(),
    user_ids: z.array(z.string()).optional(),
    group_ids: z.array(z.string()).optional(),
  })
  .strict()
const openDmInput = z.object({ user_ids: z.array(z.string()).min(1) }).strict()
const uploadInput = z
  .object({
    conversation_id: uuid,
    files: z
      .array(
        z
          .object({
            filename: z.string().min(1),
            mime: z.string().min(1).optional(),
            content_base64: z.string(),
          })
          .strict(),
      )
      .min(1),
  })
  .strict()
const postInput = z
  .object({
    conversation_id: uuid,
    body: z.string(),
    parent_id: uuid.optional(),
    reply_to_id: uuid.optional(),
    attachment_ids: z.array(z.string()).optional(),
    voice_clips: z.array(z.object({ file_id: z.string(), duration_ms: z.number() }).strict()).optional(),
  })
  .strict()
const editInput = z.object({ message_id: uuid, body: z.string() }).strict()
const reactInput = z.object({ message_id: uuid, emoji: z.string().min(1) }).strict()
const dndInput = z.object({ do_not_disturb: z.boolean() }).strict()
const shareWhereInput = z.object({ share_where: z.boolean() }).strict()
const presenceInput = z.object({ user_id: z.string().min(1).optional() }).strict()

async function liveDeps(): Promise<MessagesDeps> {
  const { messagesDeps } = await import('./live')
  return messagesDeps()
}

async function livePresence(): Promise<PresencePort> {
  return (await import('$lib/server/presence')).presence()
}

async function liveShareWhere(): Promise<ShareWherePort> {
  return (await import('$lib/server/presence')).shareWhereStore()
}

async function liveWhereDrive(): Promise<WhereDrivePort> {
  return (await import('./live')).liveWhereDrive()
}

async function liveCoworkers(): Promise<CoworkerPresencePort> {
  return (await import('$lib/server/coworkers/presence')).liveCoworkerPresence()
}

function livePush(d: MessagesDeps, c: Conversation, m: MessageDto): void {
  import('./live')
    .then(({ pushNewMessage }) => pushNewMessage(d, c, m))
    .catch((err) => console.error('[messages] push dispatch failed', { conversationId: c.id, err }))
}

/** Public channels carry the company grant (set at creation, never changed in C1). */
async function companyChannel(_d: MessagesDeps, c: Conversation): Promise<boolean> {
  return c.kind === 'channel' && !c.archived && !c.private
}

async function companyChannels(d: MessagesDeps): Promise<Conversation[]> {
  const out: Conversation[] = []
  for (const c of await d.store.listChannels()) if (await companyChannel(d, c)) out.push(c)
  return out.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

const isPerson = (ctx: ToolContext) => ctx.principal.kind === 'human'
/** A person or an AI co-worker: someone with a seat, who reads and writes with their own access. */
const isMember = (ctx: ToolContext) => actsAsMember(ctx.principal)

/**
 * The tools an AI co-worker reaches like a member (C3). Everything else in
 * Messages — creating channels, uploads, edits, deletes, Do not disturb, Share
 * where I am, reading where people are — stays a person's own act.
 */
export const MEMBER_TOOLS = [
  'messages.list_channels',
  'messages.read',
  'messages.thread',
  'messages.members',
  'messages.open_dm',
  'messages.post',
  'messages.react',
  'messages.mark_read',
] as const

function personId(ctx: ToolContext): string {
  if (!isPerson(ctx)) throw new MessagesError('forbidden', 'only a person can do this in Messages')
  return ctx.principal.id
}

function memberId(ctx: ToolContext): string {
  if (!isMember(ctx)) throw new MessagesError('forbidden', 'only a member (a person or an AI co-worker) can do this in Messages')
  return ctx.principal.id
}

/** Persons only: admin + member (the agent principal is read-only, W-2). */
const PERSON = { roles: ['admin', 'member'] }

/** Strict standard base64 (the same bytes the multipart route receives). */
function decodeBase64(s: string, filename: string): Uint8Array {
  if (s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) {
    throw new MessagesError('invalid', `${filename}: content_base64 is not valid base64`)
  }
  return new Uint8Array(Buffer.from(s, 'base64'))
}

export function createMessagesTools(
  opts: {
    deps?: () => Promise<MessagesDeps>
    presence?: () => Promise<PresencePort>
    shareWhere?: () => Promise<ShareWherePort>
    whereDrive?: () => Promise<WhereDrivePort>
    coworkerPresence?: () => Promise<CoworkerPresencePort>
    push?: PushFn
  } = {},
): ToolDescriptor[] {
  const deps = opts.deps ?? liveDeps
  const presence = opts.presence ?? livePresence
  const shareWhere = opts.shareWhere ?? liveShareWhere
  const whereDrive = opts.whereDrive ?? liveWhereDrive
  const coworkerPresence = opts.coworkerPresence ?? liveCoworkers
  const push = opts.push ?? livePush

  function write<S extends z.ZodTypeAny>(
    name: string,
    summary: string,
    activity: string,
    inputSchema: S,
    run: (userId: string, d: MessagesDeps, input: z.infer<S>) => Promise<unknown>,
  ): ToolDescriptor {
    return {
      name,
      module: MESSAGES_MODULE_ID,
      summary,
      auditClass: 'mutate',
      activity: () => activity,
      inputSchema,
      permission: PERSON,
      handler: async (ctx, input) => {
        const userId = (MEMBER_TOOLS as readonly string[]).includes(name) ? memberId(ctx) : personId(ctx)
        const out = await run(userId, await deps(), inputSchema.parse(input))
        return out ?? { ok: true }
      },
    }
  }

  return [
    {
      name: 'messages.list_channels',
      module: MESSAGES_MODULE_ID,
      summary:
        'List the team chat conversations you may read: channels (and, for a member, their direct messages) with unread counts.',
      auditClass: 'read',
      inputSchema: listInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx) => {
        const d = await deps()
        if (isMember(ctx)) return { conversations: await listConversations(d, ctx.principal.id) }
        return {
          conversations: (await companyChannels(d)).map((c) => ({ id: c.id, kind: c.kind, title: c.name, topic: c.topic })),
        }
      },
    },
    {
      name: 'messages.read',
      module: MESSAGES_MODULE_ID,
      summary:
        'Read recent messages (Markdown) of one conversation you may see, by conversation_id or channel name; page back with before_id.',
      auditClass: 'read',
      inputSchema: readInput,
      permission: { roles: ['admin', 'member', 'agent'] },
      handler: async (ctx, input) => {
        const i = readInput.parse(input)
        const d = await deps()
        let id = i.conversation_id ?? null
        if (i.channel) {
          const c = await d.store.findChannelByName(i.channel.replace(/^#/, ''))
          if (!c) throw new Error('conversation not found')
          id = c.id
        }
        if (isMember(ctx)) return listMessages(d, ctx.principal.id, id!, { limit: i.limit, beforeId: i.before_id })
        const c = await d.store.getConversation(id!)
        if (!c || !(await companyChannel(d, c))) throw new Error('conversation not found')
        return messagePage(d, c, { limit: i.limit, beforeId: i.before_id })
      },
    },
    {
      name: 'messages.thread',
      module: MESSAGES_MODULE_ID,
      summary: 'Read a thread you may see: its first message (message_id) and every reply, oldest first.',
      auditClass: 'read',
      inputSchema: messageInput,
      permission: PERSON,
      handler: async (ctx, input) => listThread(await deps(), memberId(ctx), messageInput.parse(input).message_id),
    },
    {
      name: 'messages.members',
      module: MESSAGES_MODULE_ID,
      summary: "Who is in a conversation you may see (a DM's participants; everyone who may read a channel), each with the @handle that mentions them.",
      auditClass: 'read',
      inputSchema: conversationInput,
      permission: PERSON,
      handler: async (ctx, input) => ({
        members: await conversationMembers(await deps(), memberId(ctx), conversationInput.parse(input).conversation_id),
      }),
    },
    {
      name: 'messages.presence',
      module: MESSAGES_MODULE_ID,
      summary:
        "Everyone's presence (or one person's, user_id): status (in_call, dnd, online, away, offline; AI co-workers available, busy, paused) and where they are working — the sidebar area, and the page and item open only when you may open that item yourself; nowhere when they switched sharing off.",
      auditClass: 'read',
      inputSchema: presenceInput,
      permission: PERSON,
      handler: async (ctx, input) => {
        const i = presenceInput.parse(input)
        const [d, p, drive, coworkers] = await Promise.all([deps(), presence(), whereDrive(), coworkerPresence()])
        return presenceFor(d, p, drive, coworkers, personId(ctx), i.user_id)
      },
    },
    write(
      'messages.create_channel',
      'Create a channel: public (open to everyone) or private with invited user_ids / group_ids.',
      'Created a channel',
      createChannelInput,
      async (userId, d, i) => ({
        conversation: await createChannel(d, userId, {
          name: i.name,
          topic: i.topic ?? '',
          private: i.private,
          userIds: i.user_ids ?? [],
          groupIds: i.group_ids ?? [],
        }),
      }),
    ),
    write(
      'messages.open_dm',
      'Open (or find) the direct message with exactly these people (user_ids; you are included).',
      'Opened a direct message',
      openDmInput,
      async (userId, d, i) => ({ conversation: await openDm(d, userId, i.user_ids) }),
    ),
    write(
      'messages.upload_attachments',
      "Upload files (content_base64 + filename + mime) into a conversation's Drive folder, then post them with messages.post attachment_ids (a dictated recording: voice_clips). Each file is checked against the Drive size limit: { uploaded, errors }.",
      'Uploaded files to a conversation',
      uploadInput,
      async (userId, d, i) =>
        uploadAttachments(
          d,
          userId,
          i.conversation_id,
          i.files.map((f) => ({ name: f.filename, mime: f.mime ?? null, bytes: decodeBase64(f.content_base64, f.filename) })),
        ),
    ),
    write(
      'messages.post',
      'Post a message (Markdown) to a conversation you may write in; parent_id makes it a thread reply, reply_to_id quotes a message. DMs, @mentions and thread participants get a push.',
      'Posted a message',
      postInput,
      async (userId, d, i) => {
        const { message, conversation, parent } = await postMessage(d, userId, i.conversation_id, i.body, {
          parentId: i.parent_id ?? null,
          replyToId: i.reply_to_id ?? null,
          attachmentIds: i.attachment_ids ?? [],
          voiceClips: (i.voice_clips ?? []).map((v) => ({ fileId: v.file_id, durationMs: v.duration_ms })),
        })
        push(d, conversation, message)
        return { message, parent }
      },
    ),
    write('messages.edit', 'Edit one of your own messages.', 'Edited a message', editInput, async (userId, d, i) => {
      await editMessage(d, userId, i.message_id, i.body)
    }),
    write(
      'messages.delete',
      'Delete a message: your own anywhere; an owner/admin may delete any channel message (moderation, audited).',
      'Deleted a message',
      messageInput,
      async (userId, d, i) => {
        await deleteMessage(d, userId, i.message_id)
      },
    ),
    write(
      'messages.react',
      'Toggle your reaction (one emoji) on a message; answers the message.',
      'Reacted to a message',
      reactInput,
      async (userId, d, i) => ({ message: await toggleReaction(d, userId, i.message_id, i.emoji) }),
    ),
    write('messages.mark_read', 'Mark a conversation read.', 'Marked a conversation read', conversationInput, async (userId, d, i) => {
      await markRead(d, userId, i.conversation_id)
    }),
    write(
      'messages.set_do_not_disturb',
      'Switch your Do not disturb on or off; answers your presence.',
      'Switched Do not disturb',
      dndInput,
      async (userId, d, i) => ({
        presence: await setDoNotDisturb(d, await presence(), userId, { doNotDisturb: i.do_not_disturb }),
      }),
    ),
    write(
      'messages.set_share_where',
      'Switch "Share where I am" on or off (on by default): off, others see your status but never where you are working. Answers your presence.',
      'Switched Share where I am',
      shareWhereInput,
      async (userId, d, i) => ({
        presence: await setShareWhere(d, await presence(), await shareWhere(), userId, { shareWhere: i.share_where }),
      }),
    ),
  ]
}
