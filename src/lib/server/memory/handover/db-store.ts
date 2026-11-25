import { and, desc, eq, inArray, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { handoverEntries, handovers } from '$lib/server/db/handover.schema'
import { HandoverTopicTakenError, topicKey, type Handover, type HandoverEntry, type HandoverStore } from './store'

const TOPIC_INDEX = 'handover_entries_topic_uidx'

/** The Postgres unique violation of the one-entry-per-topic index (on the error or its cause). */
function isTopicTaken(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; e = (e as { cause?: unknown }).cause, depth++) {
    const pg = e as { code?: unknown; constraint_name?: unknown }
    if (pg.code === '23505' && pg.constraint_name === TOPIC_INDEX) return true
  }
  return false
}

async function topicGuard<T>(topic: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    if (isTopicTaken(err)) throw new HandoverTopicTakenError(topic.trim())
    throw err
  }
}

/** The Postgres HandoverStore (migration 0184; company-level tables, no RLS — the service decides access). */
export function dbHandoverStore(db: () => AppDatabase): HandoverStore {
  return {
    async insertHandover(h) {
      await db().insert(handovers).values(h)
    },
    async getHandover(id) {
      const [row] = await db().select().from(handovers).where(eq(handovers.id, id)).limit(1)
      return (row as Handover | undefined) ?? null
    },
    async listHandovers() {
      return (await db().select().from(handovers).orderBy(desc(handovers.updatedAt), desc(handovers.id))) as Handover[]
    },
    async touchHandover(id, at) {
      await db().update(handovers).set({ updatedAt: at }).where(eq(handovers.id, id))
    },
    async insertEntry(e) {
      await topicGuard(e.topic, () => db().insert(handoverEntries).values(e))
    },
    async getEntry(id) {
      const [row] = await db().select().from(handoverEntries).where(eq(handoverEntries.id, id)).limit(1)
      return (row as HandoverEntry | undefined) ?? null
    },
    async entryByTopic(handoverId, topic) {
      const [row] = await db()
        .select()
        .from(handoverEntries)
        .where(and(eq(handoverEntries.handoverId, handoverId), sql`lower(btrim(${handoverEntries.topic})) = ${topicKey(topic)}`))
        .limit(1)
      return (row as HandoverEntry | undefined) ?? null
    },
    async listEntries(ids) {
      if (ids.length === 0) return []
      return (await db()
        .select()
        .from(handoverEntries)
        .where(inArray(handoverEntries.handoverId, [...ids]))
        .orderBy(desc(handoverEntries.entryOn), desc(handoverEntries.updatedAt), desc(handoverEntries.id))) as HandoverEntry[]
    },
    async updateEntry(id, patch) {
      const [row] = await topicGuard(patch.topic ?? '', () => db().update(handoverEntries).set(patch).where(eq(handoverEntries.id, id)).returning())
      return (row as HandoverEntry | undefined) ?? null
    },
    async deleteEntry(id) {
      const rows = await db().delete(handoverEntries).where(eq(handoverEntries.id, id)).returning({ id: handoverEntries.id })
      return rows.length === 1
    },
  }
}
