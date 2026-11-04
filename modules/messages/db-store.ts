import { THREAD_REPLIERS, type Attachment, type Conversation, type Message, type MessageEvent, type MessagesStore, type NewEvent, type Reaction, type ThreadStats } from './store'
import { and, asc, count, desc, eq, exists, gt, inArray, isNull, lt, max, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import type { AppDatabase } from '$lib/server/db/context'
import {
  messageAttachments as attachments,
  messageConversationMembers as members,
  messageConversations as conversations,
  messageDriveFolders as driveFolders,
  messageEvents as events,
  messageReactions as reactions,
  messages,
} from '$lib/server/db/messages.schema'

/** Postgres channel every app process LISTENs on; the payload is the event id. */
export const MESSAGES_NOTIFY_CHANNEL = 'ee_messages'

/**
 * pg_advisory_xact_lock key serializing event appends ('ee_ms' as a number).
 * bigserial ids are allocated at INSERT but become visible at COMMIT; without
 * the lock a later id can commit first, a stream delivers it, and the earlier
 * id — committing after — is skipped by every `id > cursor` catch-up. Holding
 * the lock from allocation to commit makes commit order equal id order.
 */
export const MESSAGE_EVENTS_LOCK = 0x65655f6d73

type Tx = Parameters<Parameters<AppDatabase['transaction']>[0]>[0]

/** The append itself, inside the caller's transaction (exported for the interleaving test). */
export async function appendEventInTx(tx: Tx | AppDatabase, e: NewEvent): Promise<number> {
  await tx.execute(sql`select pg_advisory_xact_lock(${MESSAGE_EVENTS_LOCK})`)
  const [row] = await tx.insert(events).values(e).returning({ id: events.id })
  // pg_notify inside the insert's transaction: delivered on commit, to every process.
  await tx.execute(sql`select pg_notify(${MESSAGES_NOTIFY_CHANNEL}, ${String(row.id)})`)
  return row.id
}

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
    async listReplies(parentId) {
      return (await db
        .select()
        .from(messages)
        .where(eq(messages.parentId, parentId))
        .orderBy(asc(messages.createdAt), asc(messages.id))) as Message[]
    },
    async threadStats(parentIds) {
      const out = new Map<string, ThreadStats>()
      if (parentIds.length === 0) return out
      const rows = await db
        .select({ parentId: messages.parentId, n: count(), last: max(messages.createdAt) })
        .from(messages)
        .where(and(inArray(messages.parentId, parentIds), isNull(messages.deletedAt)))
        .groupBy(messages.parentId)
      for (const r of rows) if (r.parentId) out.set(r.parentId, { replyCount: Number(r.n), lastReplyAt: r.last, replierIds: [] })
      if (out.size === 0) return out
      // Repliers per thread, latest reply first (one row per thread × author).
      const repliers = await db
        .select({ parentId: messages.parentId, u: messages.authorId, last: max(messages.createdAt) })
        .from(messages)
        .where(and(inArray(messages.parentId, [...out.keys()]), isNull(messages.deletedAt)))
        .groupBy(messages.parentId, messages.authorId)
        .orderBy(desc(max(messages.createdAt)))
      for (const r of repliers) {
        const st = r.parentId ? out.get(r.parentId) : undefined
        if (st && st.replierIds.length < THREAD_REPLIERS) st.replierIds.push(r.u)
      }
      return out
    },
    async threadParticipants(parentId) {
      const rows = await db
        .selectDistinct({ u: messages.authorId })
        .from(messages)
        .where(or(eq(messages.id, parentId), eq(messages.parentId, parentId)))
      return rows.map((r) => r.u)
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
        .where(and(eq(messages.conversationId, id), isNull(messages.parentId), older))
        .orderBy(desc(messages.createdAt), desc(messages.id))
        .limit(limit)) as Message[]
    },
    async countUnread(id, userId, since) {
      const other = alias(messages, 'thread_other')
      // A reply counts for the people in its thread: the parent's author and earlier repliers.
      const inMyThread = exists(
        db
          .select({ one: sql`1` })
          .from(other)
          .where(
            and(
              eq(other.authorId, userId),
              or(eq(other.id, messages.parentId), eq(other.parentId, messages.parentId)),
            ),
          ),
      )
      const [row] = await db
        .select({ n: count() })
        .from(messages)
        .where(
          and(
            eq(messages.conversationId, id),
            ne(messages.authorId, userId),
            isNull(messages.deletedAt),
            since ? gt(messages.createdAt, since) : undefined,
            or(isNull(messages.parentId), inMyThread),
          ),
        )
      return Number(row?.n ?? 0)
    },
    async toggleReaction(messageId, userId, emoji, at) {
      return db.transaction(async (tx) => {
        const gone = await tx
          .delete(reactions)
          .where(and(eq(reactions.messageId, messageId), eq(reactions.userId, userId), eq(reactions.emoji, emoji)))
          .returning({ m: reactions.messageId })
        if (gone.length > 0) return false
        await tx.insert(reactions).values({ messageId, userId, emoji, createdAt: at }).onConflictDoNothing()
        return true
      })
    },
    async reactionsFor(messageIds) {
      if (messageIds.length === 0) return []
      return (await db
        .select()
        .from(reactions)
        .where(inArray(reactions.messageId, messageIds))
        .orderBy(asc(reactions.createdAt))) as Reaction[]
    },
    async insertAttachments(rows: Attachment[]) {
      if (rows.length > 0) await db.insert(attachments).values(rows)
    },
    async attachmentsFor(messageIds) {
      if (messageIds.length === 0) return []
      return (await db
        .select()
        .from(attachments)
        .where(inArray(attachments.messageId, messageIds))
        .orderBy(asc(attachments.position))) as Attachment[]
    },
    async driveFolder(scope) {
      const [row] = await db.select().from(driveFolders).where(eq(driveFolders.scope, scope)).limit(1)
      return row?.folderId ?? null
    },
    async claimDriveFolder(scope, folderId) {
      await db.insert(driveFolders).values({ scope, folderId }).onConflictDoNothing()
      const [row] = await db.select().from(driveFolders).where(eq(driveFolders.scope, scope)).limit(1)
      if (!row) throw new Error(`message drive folder for ${scope} vanished`)
      return row.folderId
    },
    async appendEvent(e: NewEvent) {
      return db.transaction((tx) => appendEventInTx(tx, e))
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
