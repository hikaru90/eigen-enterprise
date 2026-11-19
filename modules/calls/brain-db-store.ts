import type { BrainAnswer, BrainAnswerStore } from './brain'
import { and, asc, eq } from 'drizzle-orm'
import { callBrainAnswers } from '$lib/server/db/calls.schema'
import type { AppDatabase } from '$lib/server/db/context'

/**
 * The Company Brain's answers in Postgres (call_brain_answer, migration 0159).
 * Private to their asker — the calls service reads them for that person only;
 * sharing one marks it shared inside the call's locked mutation (db-store.ts).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function dbBrainAnswerStore(db: AppDatabase): BrainAnswerStore {
  return {
    async add(answer) {
      await db.insert(callBrainAnswers).values({ ...answer, sharedAt: null })
    },
    async get(id) {
      // Not an id of ours at all (the column is a uuid): no such answer, rather than a type error from Postgres.
      if (!UUID.test(id)) return null
      const [row] = await db.select().from(callBrainAnswers).where(eq(callBrainAnswers.id, id)).limit(1)
      return (row as BrainAnswer | undefined) ?? null
    },
    async listMine(callId, userId) {
      return (await db
        .select()
        .from(callBrainAnswers)
        .where(and(eq(callBrainAnswers.callId, callId), eq(callBrainAnswers.askedBy, userId)))
        .orderBy(asc(callBrainAnswers.askedAt), asc(callBrainAnswers.id))) as BrainAnswer[]
    },
  }
}
