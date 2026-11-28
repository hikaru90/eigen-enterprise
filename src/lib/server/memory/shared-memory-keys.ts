import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { and, eq, inArray, sql, type SQL } from 'drizzle-orm'
import {
  ciphertextScope,
  decryptTenantValue,
  encryptTenantValue,
  type EncryptionScope,
} from '$lib/server/crypto/tenant-encryption'
import { getDb } from '$lib/server/db'
import { textFile, thought, thoughtEntity } from '$lib/server/db/schema'

/**
 * Keys follow visibility (plan/shared-memory-voice-agent-tools.md §1 Design):
 * a row every member may read is sealed with the company key, every other row
 * with its owner's key. Shared rows are exactly what the read policies of
 * drizzle/0164 let colleagues see:
 * - a thought: a task linked to a live project of its owner marked 'company',
 *   or any thought of an AI co-worker (company-visible, drizzle/0171);
 * - a note: marked 'company'.
 * Everything here runs in the OWNER's session (their key opens their private
 * envelopes), is idempotent, and only rewrites a ciphertext whose key is wrong.
 */

/** The thought columns that carry an encrypted copy (table 'thought'). */
const THOUGHT_SEALED_COLUMNS = [
  { field: 'rawTextEncrypted', column: 'raw_text' },
  { field: 'normalizedTextEncrypted', column: 'normalized_text' },
  { field: 'metadataEncrypted', column: 'metadata' },
] as const

type SealedField = (typeof THOUGHT_SEALED_COLUMNS)[number]['field']

/**
 * SQL: every member may read this thought row, so it is company-sealed — a task of
 * a shared project of its owner (the thought_shared_read policy, 0164), or any
 * thought of an AI co-worker (the thought_coworker_read policy, 0171), or an answer to a team
 * question (thought_team_question_read, 0203: its readers are the question's audience).
 */
export function thoughtIsSharedSql(): SQL<boolean> {
  return sql<boolean>`(("thought"."category" = 'task' AND EXISTS (
    SELECT 1 FROM thought_entity te
    JOIN canonical_entity ce ON ce.id = te.entity_id
    WHERE te.thought_id = "thought"."id"
      AND te.user_id = "thought"."user_id"
      AND ce.user_id = "thought"."user_id"
      AND ce.visibility = 'company'
      AND ce.project_status IS NOT NULL
      AND ce.project_status <> 'dismissed'))
    OR EXISTS (SELECT 1 FROM "user" cw WHERE cw.id = "thought"."user_id" AND cw.kind = 'coworker')
    OR "thought"."team_question_id" IS NOT NULL)`
}

async function reseal(
  userId: string,
  table: string,
  column: string,
  ciphertext: string,
  target: EncryptionScope,
): Promise<string | null> {
  if (ciphertextScope(ciphertext) === target) return null
  const plaintext = await decryptTenantValue({ userId, table, column, ciphertext })
  return encryptTenantValue({ userId, table, column, plaintext, scope: target })
}

/** Re-seal these thoughts of `userId` with the key their visibility calls for. Returns how many changed. */
export async function reconcileThoughtKeys(userId: string, thoughtIds: string[]): Promise<number> {
  const ids = [...new Set(thoughtIds.filter((id) => id.trim().length > 0))]
  if (ids.length === 0) return 0
  const rows = await getDb()
    .select({
      id: thought.id,
      rawTextEncrypted: thought.rawTextEncrypted,
      normalizedTextEncrypted: thought.normalizedTextEncrypted,
      metadataEncrypted: thought.metadataEncrypted,
      updatedAt: thought.updatedAt,
      shared: thoughtIsSharedSql(),
    })
    .from(thought)
    .where(and(eq(thought.userId, userId), inArray(thought.id, ids)))

  let changed = 0
  for (const row of rows) {
    const target: EncryptionScope = row.shared ? 'company' : 'person'
    const patch: Partial<Record<SealedField, string>> = {}
    for (const { field, column } of THOUGHT_SEALED_COLUMNS) {
      const current = row[field]
      if (!current) continue
      const next = await reseal(userId, 'thought', column, current, target)
      if (next) patch[field] = next
    }
    if (Object.keys(patch).length === 0) continue
    // A re-key is not an edit: updated_at keeps its value.
    await getDb()
      .update(thought)
      .set({ ...patch, updatedAt: row.updatedAt })
      .where(and(eq(thought.userId, userId), eq(thought.id, row.id)))
    changed += 1
  }
  return changed
}

/** Re-seal every thought linked to this project of `userId` (after its visibility changed). */
export async function reconcileProjectKeys(userId: string, projectEntityId: string): Promise<number> {
  const links = await getDb()
    .select({ thoughtId: thoughtEntity.thoughtId })
    .from(thoughtEntity)
    .where(and(eq(thoughtEntity.userId, userId), eq(thoughtEntity.entityId, projectEntityId)))
  return reconcileThoughtKeys(
    userId,
    links.map((link) => link.thoughtId),
  )
}

/** Re-seal one note of `userId` with the key its visibility calls for. */
export async function reconcileTextFileKey(userId: string, textFileId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({
      bodyTextEncrypted: textFile.bodyTextEncrypted,
      visibility: textFile.visibility,
      updatedAt: textFile.updatedAt,
    })
    .from(textFile)
    .where(and(eq(textFile.userId, userId), eq(textFile.id, textFileId)))
    .limit(1)
  if (!row?.bodyTextEncrypted) return false
  const target: EncryptionScope = row.visibility === 'company' ? 'company' : 'person'
  const next = await reseal(userId, 'text_file', 'body_text', row.bodyTextEncrypted, target)
  if (!next) return false
  await getDb()
    .update(textFile)
    .set({ bodyTextEncrypted: next, updatedAt: row.updatedAt })
    .where(and(eq(textFile.userId, userId), eq(textFile.id, textFileId)))
  return true
}

/** SQL: the envelope's key id ('company' or null = the owner's key). */
function keyIdSql(column: AnyPgColumn): SQL<string | null> {
  return sql<string | null>`(${column}::jsonb ->> 'k')`
}

/**
 * Every row of `userId` sealed with the wrong key: the backfill after
 * drizzle/0164 made existing projects and notes shared (SQL cannot encrypt),
 * and the safety net at every server start. Runs in `userId`'s session.
 */
export async function reconcileAllMemoryKeysOf(
  userId: string,
): Promise<{ thoughts: number; notes: number }> {
  const wantsCompany = sql`CASE WHEN ${thoughtIsSharedSql()} THEN 'company' END`
  const thoughtRows = await getDb()
    .select({ id: thought.id })
    .from(thought)
    .where(
      and(
        eq(thought.userId, userId),
        sql`(
          (${thought.rawTextEncrypted} IS NOT NULL AND ${keyIdSql(thought.rawTextEncrypted)} IS DISTINCT FROM ${wantsCompany})
          OR (${thought.normalizedTextEncrypted} IS NOT NULL AND ${keyIdSql(thought.normalizedTextEncrypted)} IS DISTINCT FROM ${wantsCompany})
          OR (${thought.metadataEncrypted} IS NOT NULL AND ${keyIdSql(thought.metadataEncrypted)} IS DISTINCT FROM ${wantsCompany})
        )`,
      ),
    )
  const thoughts = await reconcileThoughtKeys(
    userId,
    thoughtRows.map((row) => row.id),
  )

  const noteRows = await getDb()
    .select({ id: textFile.id })
    .from(textFile)
    .where(
      and(
        eq(textFile.userId, userId),
        sql`${textFile.bodyTextEncrypted} IS NOT NULL`,
        sql`${keyIdSql(textFile.bodyTextEncrypted)} IS DISTINCT FROM (CASE WHEN ${textFile.visibility} = 'company' THEN 'company' END)`,
      ),
    )
  let notes = 0
  for (const row of noteRows) {
    if (await reconcileTextFileKey(userId, row.id)) notes += 1
  }
  return { thoughts, notes }
}

/** Server start: re-key every person's Memory (each in their own session). Fails loud per person, never silently. */
export async function reconcileSharedMemoryKeysAtStartup(): Promise<void> {
  const { appSql, withDbUser } = await import('$lib/server/db')
  const users = await appSql<{ id: string }[]>`select id from "user"`
  for (const { id } of users) {
    try {
      const result = await withDbUser(id, () => reconcileAllMemoryKeysOf(id))
      if (result.thoughts + result.notes > 0) {
        console.info('[shared-memory-keys] re-keyed', { userId: id, ...result })
      }
    } catch (err) {
      console.error('[shared-memory-keys] re-key failed: shared Memory of this person may not open for colleagues', {
        userId: id,
        message: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      })
    }
  }
}
