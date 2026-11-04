import type { AccessLevel, AccessPort, GrantInput } from './access-port'
import type { Attachment, Conversation, Directory, Message, MessagesStore, Person } from './store'
import { randomUUID } from 'node:crypto'

/**
 * Messages core (plan/phase-workspace.md C1): channels and DMs between
 * members. Access: a channel goes through the access contract (public =
 * company grant, private = people/group grants, owner/admin always manage);
 * a DM is visible to its participants only. Anything a person may not see
 * answers "not found" — its existence never leaks.
 */

export const MAX_BODY = 8000
export const MAX_DM_MEMBERS = 8
export const PAGE_SIZE = 50
export const MAX_ATTACHMENTS = 10

/** The reaction picker's set (C2): a compact, fixed list — anything else is refused. */
export const REACTION_EMOJI = ['👍', '❤️', '😂', '🎉', '😮', '😢', '🙏', '👀', '✅', '🔥'] as const

/** Kernel audit for moderation (an owner/admin deleting someone else's message). */
export type MessagesAudit = (event: { type: string; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type DriveFileInfo = { id: string; name: string; mime: string; size: number; folderId: string | null; ownerId: string }

/**
 * Messages' seam onto the Drive (C2 attachments). Folders are created by the
 * system (no creator grant) and then given the conversation's access with
 * `initFolderGrants`; files are uploaded AS the person, so the Drive's own
 * access check (edit on the folder) and size limit apply.
 */
export type AttachmentPort = {
  createSystemFolder(parentId: string | null, name: string): Promise<string>
  initFolderGrants(creatorId: string, folderId: string, grants: GrantInput[]): Promise<void>
  upload(
    actorId: string,
    folderId: string,
    file: { name: string; bytes: Uint8Array; mime: string | null },
  ): Promise<{ ok: true; file: DriveFileInfo } | { ok: false; error: string }>
  /** The file when the person may view it, else null. */
  fileInfo(actorId: string, fileId: string): Promise<DriveFileInfo | null>
}

export type MessagesDeps = {
  store: MessagesStore
  access: AccessPort
  directory: Directory
  /** Required for moderation deletes (fails loud without it). */
  audit?: MessagesAudit
  /** Required for attachments (fails loud without it). */
  drive?: AttachmentPort
  now?: () => Date
  newId?: () => string
}

export class MessagesError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message)
  }
}

export type ReactionDto = { emoji: string; userIds: string[]; names: string[] }
export type AttachmentDto = { fileId: string; name: string; mime: string; size: number; image: boolean }

export type MessageDto = {
  id: string
  conversationId: string
  authorId: string
  authorName: string
  /** The author's profile picture route (P-5), null without one. */
  authorImage: string | null
  body: string
  createdAt: string
  editedAt: string | null
  deleted: boolean
  /** The thread's parent (replies only). */
  parentId: string | null
  /** Top-level messages: live replies in its thread and the latest one's time. */
  replyCount: number
  lastReplyAt: string | null
  /** Who replied in the thread, most recent first (at most three — the summary's avatars). */
  replierIds: string[]
  reactions: ReactionDto[]
  attachments: AttachmentDto[]
}

export type ConversationSummary = {
  id: string
  kind: 'channel' | 'dm'
  /** Channel name, or the other participants' names for a DM. */
  title: string
  topic: string
  private: boolean
  unread: number
  /** DM participants (empty for channels). */
  memberIds: string[]
}

const now = (d: MessagesDeps) => (d.now ? d.now() : new Date())
const newId = (d: MessagesDeps) => (d.newId ? d.newId() : randomUUID())

/** Whether the person may see (view) or post to (edit) the conversation. */
export async function canUse(
  d: MessagesDeps,
  userId: string,
  c: Conversation,
  level: AccessLevel = 'view',
): Promise<boolean> {
  if (c.kind === 'dm') return (await d.store.memberIds(c.id)).includes(userId)
  if (c.archived && level !== 'view') return false
  return d.access.canAccess(userId, 'channel', c.id, level)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
export const isId = (v: string) => UUID.test(v)

async function visible(d: MessagesDeps, userId: string, id: string, level: AccessLevel = 'view') {
  const c = isId(id) ? await d.store.getConversation(id) : null
  if (!c || !(await canUse(d, userId, c, 'view'))) throw new MessagesError('not_found', 'conversation not found')
  if (level !== 'view' && !(await canUse(d, userId, c, level))) {
    throw new MessagesError('forbidden', 'you can read this conversation but not post in it')
  }
  return c
}

async function peopleById(d: MessagesDeps): Promise<Map<string, Person>> {
  return new Map((await d.directory.listPeople()).map((p) => [p.id, p]))
}

const displayName = (p: Person | undefined) => (p ? p.name.trim() || p.email : 'Former member')

/** Raster images the browser shows inline (SVG is never inlined: active content). */
export const isInlineImage = (mime: string) => /^image\/(png|jpe?g|gif|webp|avif)$/i.test(mime)

/** DTOs for a batch of messages: thread stats, reactions and attachments loaded once. */
export async function messageDtos(d: MessagesDeps, ms: Message[], people?: Map<string, Person>): Promise<MessageDto[]> {
  if (ms.length === 0) return []
  const map = people ?? (await peopleById(d))
  const ids = ms.map((m) => m.id)
  const [stats, reactions, files] = await Promise.all([
    d.store.threadStats(ms.filter((m) => m.parentId === null).map((m) => m.id)),
    d.store.reactionsFor(ids),
    d.store.attachmentsFor(ids),
  ])
  return ms.map((m) => {
    const st = stats.get(m.id)
    const deleted = m.deletedAt !== null
    const byEmoji = new Map<string, string[]>()
    if (!deleted) {
      for (const r of reactions) {
        if (r.messageId !== m.id) continue
        byEmoji.set(r.emoji, [...(byEmoji.get(r.emoji) ?? []), r.userId])
      }
    }
    return {
      id: m.id,
      conversationId: m.conversationId,
      authorId: m.authorId,
      authorName: displayName(map.get(m.authorId)),
      authorImage: map.get(m.authorId)?.image ?? null,
      body: deleted ? '' : m.body,
      createdAt: m.createdAt.toISOString(),
      editedAt: m.editedAt?.toISOString() ?? null,
      deleted,
      parentId: m.parentId,
      replyCount: st?.replyCount ?? 0,
      lastReplyAt: st?.lastReplyAt?.toISOString() ?? null,
      replierIds: st?.replierIds ?? [],
      reactions: [...byEmoji].map(([emoji, userIds]) => ({
        emoji,
        userIds,
        names: userIds.map((u) => displayName(map.get(u))),
      })),
      attachments: deleted
        ? []
        : files
            .filter((a) => a.messageId === m.id)
            .map((a) => ({ fileId: a.fileId, name: a.name, mime: a.mime, size: a.size, image: isInlineImage(a.mime) })),
    }
  })
}

export async function messageDto(d: MessagesDeps, m: Message, people?: Map<string, Person>): Promise<MessageDto> {
  return (await messageDtos(d, [m], people))[0]
}

export async function unreadFor(d: MessagesDeps, userId: string, conversationId: string): Promise<number> {
  return d.store.countUnread(conversationId, userId, await d.store.lastReadAt(conversationId, userId))
}

export async function summarize(
  d: MessagesDeps,
  userId: string,
  c: Conversation,
  people?: Map<string, Person>,
): Promise<ConversationSummary> {
  const memberIds = c.kind === 'dm' ? await d.store.memberIds(c.id) : []
  let title = c.name ?? ''
  if (c.kind === 'dm') {
    const map = people ?? (await peopleById(d))
    const others = memberIds.filter((u) => u !== userId)
    title = others.length === 0 ? 'Just you' : others.map((u) => displayName(map.get(u))).join(', ')
  }
  return {
    id: c.id,
    kind: c.kind,
    title,
    topic: c.topic,
    private: c.private,
    unread: await unreadFor(d, userId, c.id),
    memberIds,
  }
}

/** Channels the person may see, then their DMs, each with its unread count. */
export async function listConversations(d: MessagesDeps, userId: string): Promise<ConversationSummary[]> {
  const people = await peopleById(d)
  const channels: Conversation[] = []
  for (const c of await d.store.listChannels()) {
    if (!c.archived && (await canUse(d, userId, c))) channels.push(c)
  }
  channels.sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
  const dms = (await d.store.listDmsFor(userId)).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
  const out: ConversationSummary[] = []
  for (const c of [...channels, ...dms]) out.push(await summarize(d, userId, c, people))
  return out
}

export type CreateChannelInput = {
  name: string
  topic?: string
  private: boolean
  userIds?: string[]
  groupIds?: string[]
}

export function normalizeChannelName(raw: string): string {
  const name = raw.trim().replace(/^#+/, '').trim()
  if (name.length === 0) throw new MessagesError('invalid', 'a channel needs a name')
  if (name.length > 80) throw new MessagesError('invalid', 'channel names are at most 80 characters')
  return name
}

export async function createChannel(
  d: MessagesDeps,
  actorId: string,
  input: CreateChannelInput,
): Promise<ConversationSummary> {
  if (!(await d.directory.role(actorId))) throw new MessagesError('forbidden', 'only members can create channels')
  const name = normalizeChannelName(input.name)
  if (await d.store.findChannelByName(name)) throw new MessagesError('conflict', `#${name} already exists`)
  const people = await peopleById(d)
  const userIds = [...new Set(input.userIds ?? [])].filter((u) => u !== actorId)
  const unknown = userIds.filter((u) => !people.has(u))
  if (unknown.length > 0) throw new MessagesError('invalid', `unknown people: ${unknown.join(', ')}`)
  const groupIds = [...new Set(input.groupIds ?? [])]
  if (!input.private && (userIds.length > 0 || groupIds.length > 0)) {
    throw new MessagesError('invalid', 'a public channel is open to everyone; invite people to private channels')
  }

  const c: Conversation = {
    id: newId(d),
    kind: 'channel',
    name,
    topic: (input.topic ?? '').trim(),
    private: input.private,
    archived: false,
    dmKey: null,
    createdBy: actorId,
    createdAt: now(d),
  }
  await d.store.insertConversation(c, [actorId])
  const grants: GrantInput[] = [{ subject: { kind: 'user', userId: actorId }, level: 'manage' }]
  if (!input.private) grants.push({ subject: { kind: 'company' }, level: 'edit' })
  for (const userId of userIds) grants.push({ subject: { kind: 'user', userId }, level: 'edit' })
  for (const groupId of groupIds) grants.push({ subject: { kind: 'group', groupId }, level: 'edit' })
  await d.access.initGrants(actorId, 'channel', c.id, grants)
  await d.store.appendEvent({ kind: 'conversation.created', conversationId: c.id, messageId: null, userId: null })
  return summarize(d, actorId, c, people)
}

export const dmKeyOf = (userIds: readonly string[]) => [...new Set(userIds)].sort().join(',')

/** Opens the DM for exactly this member set (the actor included), creating it once. */
export async function openDm(d: MessagesDeps, actorId: string, otherIds: string[]): Promise<ConversationSummary> {
  const people = await peopleById(d)
  if (!people.has(actorId)) throw new MessagesError('forbidden', 'only members can send direct messages')
  const memberIds = [...new Set([actorId, ...otherIds])]
  if (memberIds.length < 2) throw new MessagesError('invalid', 'pick at least one other person')
  if (memberIds.length > MAX_DM_MEMBERS) {
    throw new MessagesError('invalid', `a direct message has at most ${MAX_DM_MEMBERS} people; use a channel`)
  }
  const unknown = memberIds.filter((u) => !people.has(u))
  if (unknown.length > 0) throw new MessagesError('invalid', `unknown people: ${unknown.join(', ')}`)
  const dmKey = dmKeyOf(memberIds)
  const existing = await d.store.findDmByKey(dmKey)
  if (existing) return summarize(d, actorId, existing, people)
  const c: Conversation = {
    id: newId(d),
    kind: 'dm',
    name: null,
    topic: '',
    private: true,
    archived: false,
    dmKey,
    createdBy: actorId,
    createdAt: now(d),
  }
  await d.store.insertConversation(c, memberIds)
  await d.store.appendEvent({ kind: 'conversation.created', conversationId: c.id, messageId: null, userId: null })
  return summarize(d, actorId, c, people)
}

export function normalizeBody(raw: string): string {
  const body = raw.replace(/\s+$/, '').replace(/^\s*\n/, '')
  if (body.trim().length === 0) throw new MessagesError('invalid', 'a message cannot be empty')
  if (body.length > MAX_BODY) throw new MessagesError('invalid', `messages are at most ${MAX_BODY} characters`)
  return body
}

export type PostOptions = { parentId?: string | null; attachmentIds?: string[] }

export async function postMessage(
  d: MessagesDeps,
  actorId: string,
  conversationId: string,
  rawBody: string,
  opts: PostOptions = {},
): Promise<{ message: MessageDto; conversation: Conversation; parent: MessageDto | null }> {
  const attachmentIds = [...new Set(opts.attachmentIds ?? [])]
  if (attachmentIds.length > MAX_ATTACHMENTS) {
    throw new MessagesError('invalid', `a message carries at most ${MAX_ATTACHMENTS} files`)
  }
  const body = attachmentIds.length > 0 && rawBody.trim() === '' ? '' : normalizeBody(rawBody)
  const c = await visible(d, actorId, conversationId, 'edit')
  let parent: Message | null = null
  if (opts.parentId) {
    parent = isId(opts.parentId) ? await d.store.getMessage(opts.parentId) : null
    if (!parent || parent.conversationId !== c.id) throw new MessagesError('not_found', 'message not found')
    if (parent.parentId !== null) throw new MessagesError('invalid', 'reply to the thread’s first message')
    if (parent.deletedAt) throw new MessagesError('invalid', 'that message was deleted')
  }
  const files = await attachableFiles(d, actorId, c, attachmentIds)
  const m: Message = {
    id: newId(d),
    conversationId: c.id,
    authorId: actorId,
    body,
    parentId: parent?.id ?? null,
    createdAt: now(d),
    editedAt: null,
    deletedAt: null,
  }
  await d.store.insertMessage(m)
  await d.store.insertAttachments(
    files.map((f, position): Attachment => ({ messageId: m.id, fileId: f.id, position, name: f.name, mime: f.mime, size: f.size })),
  )
  // A thread reply leaves the main log's read state alone (the reply is not in it).
  if (!parent) await d.store.setLastRead(c.id, actorId, m.createdAt)
  await d.store.appendEvent({ kind: 'message.created', conversationId: c.id, messageId: m.id, userId: null })
  const people = await peopleById(d)
  return {
    message: await messageDto(d, m, people),
    conversation: c,
    parent: parent ? await messageDto(d, parent, people) : null,
  }
}

/** Files the actor uploaded into this conversation's folder (anything else is refused). */
async function attachableFiles(d: MessagesDeps, actorId: string, c: Conversation, ids: string[]): Promise<DriveFileInfo[]> {
  if (ids.length === 0) return []
  const drive = requireDrive(d)
  const folderId = await d.store.driveFolder(c.id)
  const out: DriveFileInfo[] = []
  for (const id of ids) {
    const f = await drive.fileInfo(actorId, id)
    if (!f || folderId === null || f.folderId !== folderId || f.ownerId !== actorId) {
      throw new MessagesError('invalid', 'attach files by uploading them to this conversation')
    }
    out.push(f)
  }
  return out
}

function requireDrive(d: MessagesDeps): AttachmentPort {
  if (!d.drive) throw new Error('messages: attachments need the Drive port (deps.drive), none is wired')
  return d.drive
}

/** "Messages / #general" (or "Messages / DM · Bea, Carl"): the conversation's Drive folder, created on first use. */
export async function conversationFolder(d: MessagesDeps, actorId: string, c: Conversation): Promise<string> {
  const existing = await d.store.driveFolder(c.id)
  if (existing) return existing
  const drive = requireDrive(d)
  let root = await d.store.driveFolder('root')
  if (!root) root = await d.store.claimDriveFolder('root', await drive.createSystemFolder(null, 'Messages'))
  let name = `#${c.name}`
  let grants: GrantInput[]
  if (c.kind === 'dm') {
    const memberIds = await d.store.memberIds(c.id)
    const people = await peopleById(d)
    name = `DM · ${memberIds.map((u) => displayName(people.get(u))).sort().join(', ')}`.slice(0, 200)
    grants = memberIds.map((userId) => ({ subject: { kind: 'user', userId }, level: 'edit' }))
  } else {
    // The channel's access, mirrored: the same subjects at the same levels.
    grants = (await d.access.listGrants(actorId, 'channel', c.id)).map((g) => ({ subject: g.subject, level: g.level }))
  }
  const folderId = await drive.createSystemFolder(root, name)
  await drive.initFolderGrants(actorId, folderId, grants)
  const winner = await d.store.claimDriveFolder(c.id, folderId)
  if (winner !== folderId) console.warn('[messages] concurrent first attachment: an empty folder was left unused', { folderId, winner })
  return winner
}

export type UploadedAttachment = AttachmentDto

/** Uploads files into the conversation's Drive folder (the Drive's size limit applies per file). */
export async function uploadAttachments(
  d: MessagesDeps,
  actorId: string,
  conversationId: string,
  files: Array<{ name: string; bytes: Uint8Array; mime: string | null }>,
): Promise<{ uploaded: UploadedAttachment[]; errors: string[] }> {
  const c = await visible(d, actorId, conversationId, 'edit')
  if (files.length === 0) throw new MessagesError('invalid', 'choose at least one file')
  if (files.length > MAX_ATTACHMENTS) throw new MessagesError('invalid', `attach at most ${MAX_ATTACHMENTS} files at once`)
  const drive = requireDrive(d)
  const folderId = await conversationFolder(d, actorId, c)
  const uploaded: UploadedAttachment[] = []
  const errors: string[] = []
  for (const f of files) {
    const r = await drive.upload(actorId, folderId, f)
    if (r.ok) uploaded.push({ fileId: r.file.id, name: r.file.name, mime: r.file.mime, size: r.file.size, image: isInlineImage(r.file.mime) })
    else errors.push(r.error)
  }
  return { uploaded, errors }
}

export type MessagePage = { messages: MessageDto[]; hasMore: boolean }

/** One page, oldest first; `beforeId` pages further back ("load earlier"). */
export async function listMessages(
  d: MessagesDeps,
  actorId: string,
  conversationId: string,
  opts: { beforeId?: string | null; limit?: number } = {},
): Promise<MessagePage> {
  return messagePage(d, await visible(d, actorId, conversationId), opts)
}

/** A page of `c` — callers have already decided the reader may see it. */
export async function messagePage(
  d: MessagesDeps,
  c: Conversation,
  opts: { beforeId?: string | null; limit?: number } = {},
): Promise<MessagePage> {
  const limit = Math.min(Math.max(opts.limit ?? PAGE_SIZE, 1), 200)
  let before: Message | null = null
  if (opts.beforeId) {
    before = isId(opts.beforeId) ? await d.store.getMessage(opts.beforeId) : null
    if (!before || before.conversationId !== c.id) throw new MessagesError('invalid', 'unknown cursor')
  }
  if (before && before.parentId !== null) throw new MessagesError('invalid', 'unknown cursor')
  const rows = await d.store.listMessagesBefore(c.id, before, limit + 1)
  return {
    hasMore: rows.length > limit,
    messages: await messageDtos(d, rows.slice(0, limit).reverse()),
  }
}

/** A thread: its first message and every reply, oldest first. */
export async function listThread(
  d: MessagesDeps,
  actorId: string,
  parentId: string,
): Promise<{ parent: MessageDto; replies: MessageDto[] }> {
  const parent = isId(parentId) ? await d.store.getMessage(parentId) : null
  if (!parent || parent.parentId !== null) throw new MessagesError('not_found', 'message not found')
  await visible(d, actorId, parent.conversationId)
  const people = await peopleById(d)
  const [p, ...replies] = await messageDtos(d, [parent, ...(await d.store.listReplies(parent.id))], people)
  return { parent: p, replies }
}

/** Toggles the actor's reaction; returns the message as everyone now sees it. */
export async function toggleReaction(d: MessagesDeps, actorId: string, messageId: string, emoji: string): Promise<MessageDto> {
  if (!(REACTION_EMOJI as readonly string[]).includes(emoji)) throw new MessagesError('invalid', 'pick a reaction from the list')
  const m = isId(messageId) ? await d.store.getMessage(messageId) : null
  if (!m || m.deletedAt) throw new MessagesError('not_found', 'message not found')
  await visible(d, actorId, m.conversationId, 'edit')
  await d.store.toggleReaction(m.id, actorId, emoji, now(d))
  await d.store.appendEvent({ kind: 'message.reacted', conversationId: m.conversationId, messageId: m.id, userId: actorId })
  return messageDto(d, m)
}

/**
 * Who is in a conversation (the header's member count and avatars): a DM's
 * participants; for a channel, every member who may read it (a public
 * channel = everyone; a private one = its people and groups, plus owner/admin).
 */
export async function conversationMembers(d: MessagesDeps, actorId: string, conversationId: string): Promise<Person[]> {
  const c = await visible(d, actorId, conversationId)
  const people = await d.directory.listPeople()
  if (c.kind === 'dm') {
    const ids = new Set(await d.store.memberIds(c.id))
    return people.filter((p) => ids.has(p.id))
  }
  const out: Person[] = []
  for (const p of people) if (await canUse(d, p.id, c, 'view')) out.push(p)
  return out
}

export async function markRead(d: MessagesDeps, actorId: string, conversationId: string): Promise<void> {
  const c = await visible(d, actorId, conversationId)
  await d.store.setLastRead(c.id, actorId, now(d))
  await d.store.appendEvent({ kind: 'conversation.read', conversationId: c.id, messageId: null, userId: actorId })
}

export async function setViewing(d: MessagesDeps, actorId: string, conversationId: string | null): Promise<void> {
  if (conversationId) await visible(d, actorId, conversationId)
  await d.store.setViewing(actorId, conversationId, now(d))
}

async function ownMessage(d: MessagesDeps, actorId: string, messageId: string): Promise<Message> {
  const m = isId(messageId) ? await d.store.getMessage(messageId) : null
  if (!m || m.deletedAt) throw new MessagesError('not_found', 'message not found')
  await visible(d, actorId, m.conversationId)
  if (m.authorId !== actorId) throw new MessagesError('forbidden', 'you can only change your own messages')
  return m
}

export async function editMessage(d: MessagesDeps, actorId: string, messageId: string, rawBody: string) {
  const m = await ownMessage(d, actorId, messageId)
  const hasFiles = (await d.store.attachmentsFor([m.id])).length > 0
  const body = hasFiles && rawBody.trim() === '' ? '' : normalizeBody(rawBody)
  await d.store.updateMessage(m.id, { body, editedAt: now(d) })
  await d.store.appendEvent({ kind: 'message.edited', conversationId: m.conversationId, messageId: m.id, userId: null })
}

/** Whether the actor may delete this message: their own, or (owner/admin) anyone's in a channel. */
export async function canDelete(d: MessagesDeps, actorId: string, m: Message, c: Conversation): Promise<boolean> {
  if (m.authorId === actorId) return true
  return c.kind === 'channel' && isModerator(await d.directory.role(actorId))
}

const isModerator = (role: string | null) => role === 'owner' || role === 'admin'

/**
 * Deletes a message: the author's own anywhere; an owner/admin may delete any
 * message in a channel (moderation, audited as messages.message_moderated).
 * DMs are never moderated — only their authors delete there.
 */
export async function deleteMessage(d: MessagesDeps, actorId: string, messageId: string) {
  const m = isId(messageId) ? await d.store.getMessage(messageId) : null
  if (!m || m.deletedAt) throw new MessagesError('not_found', 'message not found')
  const c = await visible(d, actorId, m.conversationId)
  if (!(await canDelete(d, actorId, m, c))) throw new MessagesError('forbidden', 'you can only delete your own messages')
  const moderated = m.authorId !== actorId
  const audit = d.audit
  if (moderated && !audit) {
    throw new Error('messages: moderation deletes need the audit sink (deps.audit), none is wired')
  }
  await d.store.updateMessage(m.id, { deletedAt: now(d) })
  if (moderated && audit) {
    await audit({
      type: 'messages.message_moderated',
      principalId: actorId,
      payload: { conversationId: c.id, channel: c.name, messageId: m.id, authorId: m.authorId },
    })
  }
  await d.store.appendEvent({ kind: 'message.deleted', conversationId: m.conversationId, messageId: m.id, userId: null })
}
