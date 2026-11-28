import type { CallChatStore, ChatImageInfo, ChatMessage, NewChatMessage } from './chat'
import { and, asc, count, eq, gt, inArray, sql } from 'drizzle-orm'
import { callChatImages, callChatMessages } from '$lib/server/db/calls.schema'
import type { AppDatabase } from '$lib/server/db/context'

/**
 * A call's chat in Postgres (call_chat_message, migration 0169). Every line
 * wakes every console process on commit: pg_notify(CALLS_CHAT_NOTIFY_CHANNEL,
 * <seq>) — the hub loads that one line and sends it to each person who may
 * read it (CallsHub.dispatchChat).
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export const CALLS_CHAT_NOTIFY_CHANNEL = 'ee_calls_chat'

/** The NOTIFY payload back to a seq; anything else is a bug, not a line. */
export function chatSeqOf(payload: string): number {
  const seq = Number(payload)
  if (!/^[1-9][0-9]*$/.test(payload) || !Number.isSafeInteger(seq)) throw new Error(`calls: chat notify payload is not a seq: ${JSON.stringify(payload)}`)
  return seq
}

export function dbChatStore(db: AppDatabase): CallChatStore {
  return {
    async add(message: NewChatMessage): Promise<ChatMessage> {
      return db.transaction(async (tx) => {
        const [row] = await tx.insert(callChatMessages).values(message).returning()
        if (!row) throw new Error(`calls: storing a chat line of ${message.callId} returned nothing`)
        // Inside the write's transaction: delivered on commit, to every process.
        await tx.execute(sql`select pg_notify(${CALLS_CHAT_NOTIFY_CHANNEL}, ${String(row.seq)})`)
        return row as ChatMessage
      })
    },
    async list(callId, since, limit) {
      const where = since === undefined ? eq(callChatMessages.callId, callId) : and(eq(callChatMessages.callId, callId), gt(callChatMessages.seq, since))
      const q = db.select().from(callChatMessages).where(where).orderBy(asc(callChatMessages.seq))
      return (await (limit === undefined ? q : q.limit(limit))) as ChatMessage[]
    },
    async get(seq) {
      const [row] = await db.select().from(callChatMessages).where(eq(callChatMessages.seq, seq)).limit(1)
      return (row as ChatMessage | undefined) ?? null
    },
    async countByCall(callIds) {
      if (callIds.length === 0) return new Map()
      const rows = await db
        .select({ callId: callChatMessages.callId, n: count() })
        .from(callChatMessages)
        .where(inArray(callChatMessages.callId, callIds))
        .groupBy(callChatMessages.callId)
      return new Map(rows.map((r) => [r.callId, Number(r.n)]))
    },
    async addImage(image) {
      await db.insert(callChatImages).values(image)
    },
    async image(callId, id) {
      if (!UUID.test(id)) return null
      const [row] = await db
        .select()
        .from(callChatImages)
        .where(and(eq(callChatImages.callId, callId), eq(callChatImages.id, id)))
        .limit(1)
      return row ?? null
    },
    async imageInfo(ids) {
      if (ids.length === 0) return new Map()
      const rows = await db
        .select({
          id: callChatImages.id,
          name: callChatImages.name,
          mime: callChatImages.mime,
          size: callChatImages.size,
        })
        .from(callChatImages)
        .where(inArray(callChatImages.id, ids))
      return new Map(rows.map((r): [string, ChatImageInfo] => [r.id, r]))
    },
  }
}
