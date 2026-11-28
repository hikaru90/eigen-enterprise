import { and, asc, eq, isNull } from 'drizzle-orm'
import { decryptTenantValue } from '$lib/server/crypto/tenant-encryption'
import { getDb } from '$lib/server/db'
import {
  memoryDocument,
  textFile,
  thoughtMemoryDocument,
  thoughtTextFile,
} from '$lib/server/db/schema'
import { createTextFile } from './service'

/**
 * The copy of drizzle/0191 (Memory's documents become Drive files): every
 * text_file of a person that has no Drive copy yet becomes one — same owner,
 * title, text, authorship, shared/private switch and times — and its thought
 * links move along. Runs inside the person's RLS session; idempotent (the
 * copy names its text_file, unique), so a restart mid-way finishes the rest.
 * The old rows stay until the contract migration drops them.
 */
export async function copyTextFilesToDriveFor(userId: string): Promise<{ copied: number }> {
  const db = getDb()
  const pending = await db
    .select({
      id: textFile.id,
      title: textFile.title,
      bodyText: textFile.bodyText,
      bodyTextEncrypted: textFile.bodyTextEncrypted,
      author: textFile.author,
      authorLabel: textFile.authorLabel,
      authorKeyId: textFile.authorKeyId,
      visibility: textFile.visibility,
      createdAt: textFile.createdAt,
      updatedAt: textFile.updatedAt,
    })
    .from(textFile)
    .leftJoin(memoryDocument, eq(memoryDocument.textFileId, textFile.id))
    .where(and(eq(textFile.userId, userId), isNull(memoryDocument.driveFileId)))
    .orderBy(asc(textFile.createdAt))

  for (const row of pending) {
    const body = row.bodyTextEncrypted
      ? await decryptTenantValue({
          userId,
          table: 'text_file',
          column: 'body_text',
          ciphertext: row.bodyTextEncrypted,
        })
      : row.bodyText
    const copy = await createTextFile(userId, {
      // An empty old note (neither title nor body) still gets a document.
      title: row.title.trim() || (body.trim() ? '' : 'Untitled document'),
      body,
      authorship: {
        author: row.author,
        authorLabel: row.authorLabel,
        authorKeyId: row.authorKeyId,
      },
      visibility: row.visibility,
      textFileId: row.id,
      at: { createdAt: row.createdAt, updatedAt: row.updatedAt },
    })
    const links = await db
      .select({ thoughtId: thoughtTextFile.thoughtId, createdAt: thoughtTextFile.createdAt })
      .from(thoughtTextFile)
      .where(and(eq(thoughtTextFile.userId, userId), eq(thoughtTextFile.textFileId, row.id)))
    if (links.length > 0)
      await db
        .insert(thoughtMemoryDocument)
        .values(
          links.map((l) => ({
            userId,
            thoughtId: l.thoughtId,
            driveFileId: copy.id,
            createdAt: l.createdAt,
          })),
        )
        .onConflictDoNothing()
  }
  return { copied: pending.length }
}

/** Server start: copy every person's remaining text files into Drive (logs per person, loud on failure). */
export async function copyTextFilesToDriveAtStartup(): Promise<void> {
  const { appSql, withDbUser } = await import('$lib/server/db')
  const users = await appSql<{ id: string }[]>`select id from "user"`
  for (const { id } of users) {
    try {
      const { copied } = await withDbUser(id, () => copyTextFilesToDriveFor(id))
      if (copied > 0)
        console.info('[memory-documents] copied text files into Drive', { userId: id, copied })
    } catch (err) {
      console.error(
        '[memory-documents] copy into Drive failed: this person’s older documents are not in Drive yet',
        {
          userId: id,
          message: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
        },
      )
    }
  }
}
