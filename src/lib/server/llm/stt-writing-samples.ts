import { and, desc, eq, isNull } from 'drizzle-orm'
import { withDbUser } from '$lib/server/db'
import { messages } from '$lib/server/db/messages.schema'
import { toWritingSamples, WRITING_SAMPLE_LIMIT } from './stt-judge'

/**
 * The transcript judge's evidence for which languages this person writes in: their own
 * latest messages (not deleted), trimmed and cut short. Never persisted, never logged.
 */
export async function loadWritingSamples(userId: string): Promise<string[]> {
  const rows = await withDbUser(userId, (db) =>
    db
      .select({ body: messages.body })
      .from(messages)
      .where(and(eq(messages.authorId, userId), isNull(messages.deletedAt)))
      .orderBy(desc(messages.createdAt))
      .limit(WRITING_SAMPLE_LIMIT * 2),
  )
  return toWritingSamples(rows.map((r) => r.body))
}
