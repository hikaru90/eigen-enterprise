import type { BrainIntakeStore, IntakeSince } from './brain-intake'
import { desc, eq, or, sql } from 'drizzle-orm'
import { decryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { getDb } from '$lib/server/db'
import { textFile, thought } from '$lib/server/db/schema'
import { ownerNamesOf } from '$lib/server/memory/memory-owners'

/**
 * The brain intake's reads on the database (brain-intake.ts says who sees what):
 * thoughts are the reader's own, documents the reader's own plus colleagues'
 * shared ones. Each condition is in the SQL; row-level security holds underneath.
 */

/**
 * created_at is a UTC `timestamp` (drizzle mode date): each window start goes in as its
 * UTC ISO string cast to timestamp, so both sides are the same UTC wall time.
 */
const countsSince = (
  column: typeof thought.createdAt | typeof textFile.createdAt,
  since: IntakeSince,
) => {
  const from = (d: Date) => sql`${d.toISOString()}::timestamp`
  return {
    day: sql<number>`(count(*) filter (where ${column} >= ${from(since.day)}))::int`,
    week: sql<number>`(count(*) filter (where ${column} >= ${from(since.week)}))::int`,
    month: sql<number>`(count(*) filter (where ${column} >= ${from(since.month)}))::int`,
    all: sql<number>`(count(*))::int`,
  }
}

/** The reader's own documents and colleagues' shared ones: the same rule as the RLS read policies. */
const readableDocument = (readerId: string) =>
  or(eq(textFile.userId, readerId), eq(textFile.visibility, 'company'))!

export const liveBrainIntakeStore: BrainIntakeStore = {
  async thoughtGroups(readerId, since) {
    const rows = await getDb()
      .select({
        captureSource: thought.captureSource,
        author: thought.author,
        authorLabel: thought.authorLabel,
        ...countsSince(thought.createdAt, since),
      })
      .from(thought)
      .where(eq(thought.userId, readerId))
      .groupBy(thought.captureSource, thought.author, thought.authorLabel)
    return rows.map((r) => ({ ...r, captureSource: r.captureSource ?? null }))
  },

  async documentGroups(readerId, since) {
    const own = sql<boolean>`(${textFile.userId} = ${readerId})`
    const rows = await getDb()
      .select({ own, ...countsSince(textFile.createdAt, since) })
      .from(textFile)
      .where(readableDocument(readerId))
      // By the first column: the same expression with its own parameter would not match.
      .groupBy(sql`1`)
    return rows
  },

  async recentThoughts(readerId, limit) {
    const rows = await getDb()
      .select({
        id: thought.id,
        normalizedText: thought.normalizedText,
        normalizedTextEncrypted: thought.normalizedTextEncrypted,
        category: thought.category,
        captureSource: thought.captureSource,
        author: thought.author,
        authorLabel: thought.authorLabel,
        createdAt: thought.createdAt,
      })
      .from(thought)
      .where(eq(thought.userId, readerId))
      .orderBy(desc(thought.createdAt), desc(thought.id))
      .limit(limit)
    return Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        // The reader's own thought: sealed with their key (or the company's), opened as them.
        text: row.normalizedTextEncrypted
          ? await decryptTenantValue({
              userId: readerId,
              table: 'thought',
              column: 'normalized_text',
              ciphertext: row.normalizedTextEncrypted,
            })
          : row.normalizedText,
        category: row.category,
        captureSource: row.captureSource ?? null,
        author: row.author,
        authorLabel: row.authorLabel,
        createdAt: row.createdAt,
      })),
    )
  },

  async recentDocuments(readerId, limit) {
    const rows = await getDb()
      .select({
        id: textFile.id,
        ownerId: textFile.userId,
        title: textFile.title,
        createdAt: textFile.createdAt,
      })
      .from(textFile)
      .where(readableDocument(readerId))
      .orderBy(desc(textFile.createdAt), desc(textFile.id))
      .limit(limit)
    const names = await ownerNamesOf(rows.map((r) => r.ownerId))
    return rows.map((r) => ({
      id: r.id,
      own: r.ownerId === readerId,
      ownerName: names.get(r.ownerId)!,
      title: r.title,
      createdAt: r.createdAt,
    }))
  },
}
