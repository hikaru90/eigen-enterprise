import { and, eq } from 'drizzle-orm'
import { decryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { getDb } from '$lib/server/db'
import { thought } from '$lib/server/db/schema'
import { listTextFilesForThought } from '$lib/server/text-files/service'

/** One of the person's own thoughts, decrypted, with its linked notes (GET /api/thoughts/[id], memory.get_thought). */
export async function getThoughtForUser(userId: string, thoughtId: string) {
  const [row] = await getDb()
    .select({
      id: thought.id,
      rawText: thought.rawText,
      rawTextEncrypted: thought.rawTextEncrypted,
      normalizedText: thought.normalizedText,
      normalizedTextEncrypted: thought.normalizedTextEncrypted,
      category: thought.category,
      author: thought.author,
      authorLabel: thought.authorLabel,
      metadata: thought.metadata,
      metadataEncrypted: thought.metadataEncrypted,
      updatedAt: thought.updatedAt,
    })
    .from(thought)
    .where(and(eq(thought.id, thoughtId), eq(thought.userId, userId)))
    .limit(1)
  if (!row) return null

  const decrypt = (column: string, ciphertext: string) =>
    decryptTenantValue({ userId, table: 'thought', column, ciphertext })
  const [rawText, normalizedText, metadataJson] = await Promise.all([
    row.rawTextEncrypted ? decrypt('raw_text', row.rawTextEncrypted) : Promise.resolve(row.rawText),
    row.normalizedTextEncrypted
      ? decrypt('normalized_text', row.normalizedTextEncrypted)
      : Promise.resolve(row.normalizedText),
    row.metadataEncrypted
      ? decrypt('metadata', row.metadataEncrypted)
      : Promise.resolve(JSON.stringify(row.metadata ?? {})),
  ])

  return {
    id: row.id,
    rawText,
    normalizedText,
    category: row.category,
    author: row.author,
    authorLabel: row.authorLabel,
    metadata: JSON.parse(metadataJson) as Record<string, unknown>,
    updatedAt: row.updatedAt,
    attachedFiles: await listTextFilesForThought(userId, thoughtId),
  }
}

export type ThoughtDetail = NonNullable<Awaited<ReturnType<typeof getThoughtForUser>>>
