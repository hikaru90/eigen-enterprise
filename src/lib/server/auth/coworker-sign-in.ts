import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'

/**
 * An AI co-worker never signs in (plan/phase-ai-coworkers.md §3): it has no
 * account or credential row, and Better Auth's session-create hook refuses a
 * session for it, whatever the path (email code, passkey, password, social).
 *
 * A user this lookup cannot see is left to the database: session.user_id is a
 * foreign key, so a session for no user fails there. (Refusing it here would
 * break a sign-up whose user insert shares a Better Auth transaction this pool
 * cannot see yet.)
 */
export class CoworkerSignInError extends Error {
  constructor() {
    super('This account is an AI co-worker. Co-workers never sign in; they work through the registry tools.')
    this.name = 'CoworkerSignInError'
  }
}

export type UserKindLookup = (userId: string) => Promise<'human' | 'coworker' | null>

export const dbUserKind: UserKindLookup = async (userId) => {
  const [row] = await authDb.select({ kind: user.kind }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.kind ?? null
}

/** Throws for a co-worker. Called by auth.ts databaseHooks.session.create.before. */
export async function refuseCoworkerSession(userId: string, kindOf: UserKindLookup = dbUserKind): Promise<void> {
  if ((await kindOf(userId)) === 'coworker') throw new CoworkerSignInError()
}
