/**
 * Messages domain types and the storage seam (DB-backed in db-store.ts,
 * in-memory in memory-store.ts for tests).
 */

export type ConversationKind = 'channel' | 'dm'

export type Conversation = {
  id: string
  kind: ConversationKind
  /** Channels only. */
  name: string | null
  topic: string
  private: boolean
  archived: boolean
  dmKey: string | null
  createdBy: string
  createdAt: Date
}

export type Message = {
  id: string
  conversationId: string
  authorId: string
  body: string
  parentId: string | null
  createdAt: Date
  editedAt: Date | null
  deletedAt: Date | null
}

export type MessageEventKind =
  | 'message.created'
  | 'message.edited'
  | 'message.deleted'
  | 'conversation.created'
  | 'conversation.read'

export type MessageEvent = {
  id: number
  kind: MessageEventKind
  conversationId: string
  messageId: string | null
  /** conversation.read only. */
  userId: string | null
  createdAt: Date
}

export type NewEvent = Omit<MessageEvent, 'id' | 'createdAt'>

export type Person = { id: string; name: string; email: string }

export type MessagesStore = {
  insertConversation(c: Conversation, memberIds: string[]): Promise<void>
  getConversation(id: string): Promise<Conversation | null>
  findChannelByName(name: string): Promise<Conversation | null>
  findDmByKey(dmKey: string): Promise<Conversation | null>
  listChannels(): Promise<Conversation[]>
  listDmsFor(userId: string): Promise<Conversation[]>
  setPrivate(id: string, isPrivate: boolean): Promise<void>
  addMembers(conversationId: string, userIds: string[]): Promise<void>
  memberIds(conversationId: string): Promise<string[]>
  lastReadAt(conversationId: string, userId: string): Promise<Date | null>
  /** Upserts the member row (public channels get one on first read). */
  setLastRead(conversationId: string, userId: string, at: Date): Promise<void>
  /** Marks `conversationId` as being viewed by the user (null: viewing nothing). */
  setViewing(userId: string, conversationId: string | null, at: Date): Promise<void>
  viewersSince(conversationId: string, since: Date): Promise<string[]>
  insertMessage(m: Message): Promise<void>
  getMessage(id: string): Promise<Message | null>
  updateMessage(id: string, patch: Partial<Pick<Message, 'body' | 'editedAt' | 'deletedAt'>>): Promise<void>
  /** Newest-first page strictly older than `before` (by createdAt, then id). */
  listMessagesBefore(conversationId: string, before: Message | null, limit: number): Promise<Message[]>
  /** Live messages by others created after `since` (all when since is null). */
  countUnread(conversationId: string, userId: string, since: Date | null): Promise<number>
  /** Appends an event and wakes every listening process; returns its id. */
  appendEvent(e: NewEvent): Promise<number>
  getEvent(id: number): Promise<MessageEvent | null>
  eventsAfter(id: number, limit: number): Promise<MessageEvent[]>
  /** Highest event id (0 when none): where a fresh stream starts. */
  latestEventId(): Promise<number>
}

export type Directory = {
  listPeople(): Promise<Person[]>
  role(userId: string): Promise<'owner' | 'admin' | 'member' | null>
}
