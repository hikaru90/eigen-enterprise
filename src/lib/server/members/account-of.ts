import { and, eq, isNull } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { coworkerProfile } from '$lib/server/db/coworkers.schema'

/**
 * One of the company's accounts by id, whatever its account kind (a harness
 * account included), or null. Unlike `dbMemberStore.getMember` this is not the
 * members listing: it answers who is acting, not who is listed. A removed AI
 * co-worker keeps its row but is no one.
 */
export async function accountOf(id: string): Promise<{ id: string; name: string } | null> {
  const [row] = await authDb
    .select({ id: user.id, name: user.name })
    .from(user)
    .leftJoin(coworkerProfile, eq(coworkerProfile.userId, user.id))
    .where(and(eq(user.id, id), isNull(coworkerProfile.removedAt)))
    .limit(1)
  return row ?? null
}
