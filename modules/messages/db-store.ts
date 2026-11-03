import type { Conversation, Message, MessageEvent, MessagesStore, NewEvent } from './store'
import { and, asc, count, desc, eq, gt, isNull, lt, ne, or, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import {
  messageConversationMembers as members,
  messageConversations as conversations,
  messageEvents as events,
  messages,
} from '$lib/server/db/messages.schema'

/** Postgres channel every app process LISTENs on; the payload is the event id. */
export const MESSAGES_NOTIFY_CHANNEL = 'ee_messages'

export function dbMessagesStore(db: AppDatabase): MessagesStore {
  return {
    async insertConversation(c: Conversation, memberIds: string[]) {
      await db.transaction(async (tx) => {
        await tx.insert(conversations).values(c)
        if (memberIds.length > 0) {
          await tx.insert(members).values(memberIds.map((userId) => ({ conversationId: c.id, userId })))
        }
      })
    },
    async getConversation(id) {
      const [row] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1)
      return (row as Conversation | undefined) ?? null
    },
    async findChannelByName(name) {
      const [row] = await db
        .select()
        .from(conversations)
        .where(and(eq(conversations.kind, 'channel'), sql`lower(${conversations.name}) = lower(${name})`))
        .limit(1)
      return (row as Conversation | undefined) ?? null
    },
    async findDmByKey(dmKey) {
      const [row] = await db.select().from(conversations).where(eq(conversations.dmKey, dmKey)).limit(1)
      return (row as Conversation | undefined) ?? null
    },
    async listChannels() {
      return (await db.select().from(conversations).where(eq(conversations.kind, 'channel'))) as Conversation[]
    },
    async listDmsFor(userId) {
      const rows = await db
        .select({ c: conversations })
        .from(conversations)
        .innerJoin(members, eq(members.conversationId, conversations.id))
        .where(and(eq(conversations.kind, 'dm'), eq(members.userId, userId)))
      return rows.map((r) => r.c as Conversation)
    },
    async setPrivate(id, isPrivate) {
      await db.update(conversations).set({ private: isPrivate }).where(eq(conversations.id, id))
    },
    async addMembers(id, userIds) {
      if (userIds.length === 0) return
      await db
        .insert(members)
        .values(userIds.map((userId) => ({ conversationId: id, userId })))
        .onConflictDoNothing()
    },
    async memberIds(id) {
      const rows = await db.select({ u: members.userId }).from(members).where(eq(members.conversationId, id))
      return rows.map((r) => r.u)
    },
    async lastReadAt(id, userId) {
      const [row] = await db
        .select({ at: members.lastReadAt })
        .from(members)
        .where(and(eq(members.conversationId, id), eq(members.userId, userId)))
        .limit(1)
      return row?.at ?? null
    },
    async setLastRead(id, userId, at) {
      await db
        .insert(members)
        .values({ conversationId: id, userId, lastReadAt: at })
        .onConflictDoUpdate({ target: [members.conversationId, members.userId], set: { lastReadAt: at } })
    },
    async setViewing(userId, conversationId, at) {
      await db.transaction(async (tx) => {
        await tx
          .update(members)
          .set({ viewingAt: null })
          .where(
            and(
              eq(members.userId, userId),
              conversationId ? ne(members.conversationId, conversationId) : sql`true`,
            ),
          )
        if (conversationId) {
          await tx
            .insert(members)
            .values({ conversationId, userId, viewingAt: at })
            .onConflictDoUpdate({ target: [members.conversationId, members.userId], set: { viewingAt: at } })
        }
      })
    },
    async viewersSince(id, since) {
      const rows = await db
        .select({ u: members.userId })
        .from(members)
        .where(and(eq(members.conversationId, id), gt(members.viewingAt, since)))
      return rows.map((r) => r.u)
    },
    async insertMessage(m: Message) {
      await db.insert(messages).values(m)
    },
    async getMessage(id) {
      const [row] = await db.select().from(messages).where(eq(messages.id, id)).limit(1)
      return (row as Message | undefined) ?? null
    },
    async updateMessage(id, patch) {
      await db.update(messages).set(patch).where(eq(messages.id, id))
    },
    async listMessagesBefore(id, before, limit) {
      const older = before
        ? or(
            lt(messages.createdAt, before.createdAt),
            and(eq(messages.createdAt, before.createdAt), lt(messages.id, before.id)),
          )
        : undefined
      return (await db
        .select()
        .from(messages)
        .where(and(eq(messages.conversationId, id), older))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit)) as Message[]
    },
    async countUnread(id, userId, since) {
      const [row] = await db
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, id),
            ne(messages.authorId, userId),
            isNull(messages.deletedAt),
            since ? gt(messages.createdAt, since) : undefined,
          ),
        )
      return Number(row?.n ?? 0)
    },
    async appendEvent(e: NewEvent) {
      // pg_notify inside the insert's transaction: delivered on commit, to every process.
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(events).values(e).returning({ id: events.id })
        await tx.execute(sql`select pg_notify(${MESSAGES_NOTIFY_CHANNEL}, ${String(row.id)})`)
        return row.id
      })
    },
    async getEvent(id) {
      const [row] = await db.select().from(events).where(eq(events.id, id)).limit(1)
      return (row as MessageEvent | undefined) ?? null
    },
    async eventsAfter(id, limit) {
      return (await db
        .select()
        .from(events)
        .where(gt(events.id, id))
        .orderBy(asc(events.id))
        .limit(limit)) as MessageEvent[]
    },
    async latestEventId() {
      const [row] = await db.select({ id: sql<string | null>`max(${events.id})` }).from(events)
      return Number(row?.id ?? 0)
    },
  }
}
