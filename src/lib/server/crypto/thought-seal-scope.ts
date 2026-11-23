import type { EncryptionScope } from './tenant-encryption'
import { eq } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { user } from '$lib/server/db/auth.schema'

/**
 * The key a thought of this owner is sealed with when the writer names none
 * (plan/phase-ai-coworkers.md §3, C4): an AI co-worker's thoughts are readable
 * by every member (drizzle/0171), so they are sealed with the company key from
 * the first write on — no window in which a colleague meets a personal-key
 * envelope. A person's thoughts stay sealed with their own key (shared project
 * tasks are re-keyed by shared-memory-keys.ts, as before).
 *
 * A user's kind never changes after the row is created, so the answer is kept
 * per id. The user table is readable from every session (enable_rls.sql user_read_all).
 */
const coworkerOwners = new Map<string, boolean>()

export async function thoughtSealScopeOf(userId: string): Promise<EncryptionScope> {
  let isCoworker = coworkerOwners.get(userId)
  if (isCoworker === undefined) {
    const [row] = await getDb().select({ kind: user.kind }).from(user).where(eq(user.id, userId)).limit(1)
    if (!row) throw new Error(`a thought's owner must be a user: ${userId} is none`)
    isCoworker = row.kind === 'coworker'
    coworkerOwners.set(userId, isCoworker)
  }
  return isCoworker ? 'company' : 'person'
}
