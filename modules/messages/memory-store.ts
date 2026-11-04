import { THREAD_REPLIERS, type Attachment, type Conversation, type Directory, type Message, type MessageEvent, type MessagesStore, type NewEvent, type Person, type Reaction, type ThreadStats } from './store'

type MemberRow = { lastReadAt: Date | null; viewingAt: Date | null }

/** In-memory MessagesStore (tests). `onEvent` stands in for pg_notify. */
export class MemoryMessagesStore implements MessagesStore {
  conversations = new Map<string, Conversation>()
  members = new Map<string, Map<string, MemberRow>>()
  messages = new Map<string, Message>()
  events: MessageEvent[] = []
  reactions: Reaction[] = []
  attachments: Attachment[] = []
  folders = new Map<string, string>()
  onEvent: ((id: number) => void) | null = null

  private rows(id: string) {
    let m = this.members.get(id)
    if (!m) this.members.set(id, (m = new Map()))
    return m
  }

  async insertConversation(c: Conversation, memberIds: string[]) {
    if (c.dmKey && [...this.conversations.values()].some((x) => x.dmKey === c.dmKey)) throw new Error('dm_key taken')
    this.conversations.set(c.id, { ...c })
    await this.addMembers(c.id, memberIds)
  }
  async getConversation(id: string) {
    return this.conversations.get(id) ?? null
  }
  async findChannelByName(name: string) {
    const n = name.toLowerCase()
    return [...this.conversations.values()].find((c) => c.kind === 'channel' && c.name?.toLowerCase() === n) ?? null
  }
  async findDmByKey(dmKey: string) {
    return [...this.conversations.values()].find((c) => c.dmKey === dmKey) ?? null
  }
  async listChannels() {
    return [...this.conversations.values()].filter((c) => c.kind === 'channel')
  }
  async listDmsFor(userId: string) {
    return [...this.conversations.values()].filter((c) => c.kind === 'dm' && this.rows(c.id).has(userId))
  }
  async setPrivate(id: string, isPrivate: boolean) {
    const c = this.conversations.get(id)
    if (c) c.private = isPrivate
  }
  async addMembers(id: string, userIds: string[]) {
    const rows = this.rows(id)
    for (const u of userIds) if (!rows.has(u)) rows.set(u, { lastReadAt: null, viewingAt: null })
  }
  async memberIds(id: string) {
    return [...this.rows(id).keys()]
  }
  async lastReadAt(id: string, userId: string) {
    return this.rows(id).get(userId)?.lastReadAt ?? null
  }
  async setLastRead(id: string, userId: string, at: Date) {
    const rows = this.rows(id)
    rows.set(userId, { viewingAt: null, ...rows.get(userId), lastReadAt: at })
  }
  async setViewing(userId: string, conversationId: string | null, at: Date) {
    for (const [cid, rows] of this.members) {
      const row = rows.get(userId)
      if (row) row.viewingAt = cid === conversationId ? at : null
    }
    if (conversationId && !this.rows(conversationId).has(userId)) {
      this.rows(conversationId).set(userId, { lastReadAt: null, viewingAt: at })
    }
  }
  async viewersSince(id: string, since: Date) {
    return [...this.rows(id)].filter(([, r]) => r.viewingAt && r.viewingAt >= since).map(([u]) => u)
  }
  async insertMessage(m: Message) {
    this.messages.set(m.id, { ...m })
  }
  async getMessage(id: string) {
    return this.messages.get(id) ?? null
  }
  async updateMessage(id: string, patch: Partial<Pick<Message, 'body' | 'editedAt' | 'deletedAt'>>) {
    const m = this.messages.get(id)
    if (m) Object.assign(m, patch)
  }
  private ordered(id: string) {
    return [...this.messages.values()]
      .filter((m) => m.conversationId === id)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  }
  async listMessagesBefore(id: string, before: Message | null, limit: number) {
    const all = this.ordered(id).filter((m) => m.parentId === null)
    const older = before
      ? all.filter(
          (m) =>
            m.createdAt < before.createdAt ||
            (m.createdAt.getTime() === before.createdAt.getTime() && m.id < before.id),
        )
      : all
    return older.reverse().slice(0, limit)
  }
  async listReplies(parentId: string) {
    return [...this.messages.values()]
      .filter((m) => m.parentId === parentId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
  }
  async threadStats(parentIds: string[]) {
    const out = new Map<string, ThreadStats>()
    for (const id of parentIds) {
      const live = (await this.listReplies(id)).filter((m) => !m.deletedAt)
      if (live.length === 0) continue
      const replierIds = [...new Set([...live].reverse().map((m) => m.authorId))].slice(0, THREAD_REPLIERS)
      out.set(id, { replyCount: live.length, lastReplyAt: live.at(-1)!.createdAt, replierIds })
    }
    return out
  }
  async threadParticipants(parentId: string) {
    const parent = this.messages.get(parentId)
    const ids = [...(parent ? [parent.authorId] : []), ...(await this.listReplies(parentId)).map((m) => m.authorId)]
    return [...new Set(ids)]
  }
  async countUnread(id: string, userId: string, since: Date | null) {
    const mine = (parentId: string) =>
      this.messages.get(parentId)?.authorId === userId ||
      [...this.messages.values()].some((r) => r.parentId === parentId && r.authorId === userId)
    return this.ordered(id).filter(
      (m) =>
        m.authorId !== userId &&
        !m.deletedAt &&
        (since === null || m.createdAt > since) &&
        (m.parentId === null || mine(m.parentId)),
    ).length
  }
  async toggleReaction(messageId: string, userId: string, emoji: string, at: Date) {
    const i = this.reactions.findIndex((r) => r.messageId === messageId && r.userId === userId && r.emoji === emoji)
    if (i >= 0) {
      this.reactions.splice(i, 1)
      return false
    }
    this.reactions.push({ messageId, userId, emoji, createdAt: at })
    return true
  }
  async reactionsFor(messageIds: string[]) {
    const ids = new Set(messageIds)
    return this.reactions.filter((r) => ids.has(r.messageId))
  }
  async insertAttachments(rows: Attachment[]) {
    this.attachments.push(...rows.map((r) => ({ ...r })))
  }
  async attachmentsFor(messageIds: string[]) {
    const ids = new Set(messageIds)
    return this.attachments.filter((a) => ids.has(a.messageId)).sort((a, b) => a.position - b.position)
  }
  async driveFolder(scope: string) {
    return this.folders.get(scope) ?? null
  }
  async claimDriveFolder(scope: string, folderId: string) {
    if (!this.folders.has(scope)) this.folders.set(scope, folderId)
    return this.folders.get(scope)!
  }
  async appendEvent(e: NewEvent) {
    const id = this.events.length + 1
    this.events.push({ ...e, id, createdAt: new Date() })
    this.onEvent?.(id)
    return id
  }
  async getEvent(id: number) {
    return this.events.find((e) => e.id === id) ?? null
  }
  async eventsAfter(id: number, limit: number) {
    return this.events.filter((e) => e.id > id).slice(0, limit)
  }
  async latestEventId() {
    return this.events.length
  }
}

export class MemoryDirectory implements Directory {
  constructor(
    public people: Person[] = [],
    public roles = new Map<string, 'owner' | 'admin' | 'member'>(),
  ) {}
  async listPeople() {
    return this.people
  }
  async role(userId: string) {
    return this.roles.get(userId) ?? null
  }
}
