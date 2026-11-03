import type { AccessLevel, AccessPort, GrantInput } from './access-port'
import type { Conversation, Directory, Message, MessagesStore, Person } from './store'
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

export type MessagesDeps = {
  store: MessagesStore
  access: AccessPort
  directory: Directory
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

export type MessageDto = {
  id: string
  conversationId: string
  authorId: string
  authorName: string
  body: string
  createdAt: string
  editedAt: string | null
  deleted: boolean
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

export function messageDto(m: Message, people: Map<string, Person>): MessageDto {
  return {
    id: m.id,
    conversationId: m.conversationId,
    authorId: m.authorId,
    authorName: displayName(people.get(m.authorId)),
    body: m.deletedAt ? '' : m.body,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
    deleted: m.deletedAt !== null,
  }
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

export async function postMessage(
  d: MessagesDeps,
  actorId: string,
  conversationId: string,
  rawBody: string,
): Promise<{ message: MessageDto; conversation: Conversation }> {
  const body = normalizeBody(rawBody)
  const c = await visible(d, actorId, conversationId, 'edit')
  const m: Message = {
    id: newId(d),
    conversationId: c.id,
    authorId: actorId,
    body,
    parentId: null,
    createdAt: now(d),
    editedAt: null,
    deletedAt: null,
  }
  await d.store.insertMessage(m)
  await d.store.setLastRead(c.id, actorId, m.createdAt)
  await d.store.appendEvent({ kind: 'message.created', conversationId: c.id, messageId: m.id, userId: null })
  return { message: messageDto(m, await peopleById(d)), conversation: c }
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
  const rows = await d.store.listMessagesBefore(c.id, before, limit + 1)
  const people = await peopleById(d)
  return {
    hasMore: rows.length > limit,
    messages: rows
      .slice(0, limit)
      .reverse()
      .map((m) => messageDto(m, people)),
  }
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
  const body = normalizeBody(rawBody)
  await d.store.updateMessage(m.id, { body, editedAt: now(d) })
  await d.store.appendEvent({ kind: 'message.edited', conversationId: m.conversationId, messageId: m.id, userId: null })
}

export async function deleteMessage(d: MessagesDeps, actorId: string, messageId: string) {
  const m = await ownMessage(d, actorId, messageId)
  await d.store.updateMessage(m.id, { deletedAt: now(d) })
  await d.store.appendEvent({ kind: 'message.deleted', conversationId: m.conversationId, messageId: m.id, userId: null })
}
