import { eq } from 'drizzle-orm'
import { normalizeUserNameFields } from '$lib/server/auth-user-name'
import { getDb } from '$lib/server/db'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { userPreference } from '$lib/server/db/schema'

/**
 * Marks the welcome setup wizard on `/` as done (completed or skipped) for a user.
 * Upsert on user_preference — idempotent, safe to call repeatedly. Fails loud on
 * persistence errors: a welcome that silently "succeeds" would nag forever or,
 * worse, never show again without ever having run.
 */
export async function completeWelcomeOnboarding(userId: string): Promise<void> {
  const completedAt = new Date()

  await getDb()
    .insert(userPreference)
    .values({
      userId,
      welcomeCompletedAt: completedAt,
    })
    .onConflictDoUpdate({
      target: userPreference.userId,
      set: {
        welcomeCompletedAt: completedAt,
        updatedAt: new Date(),
      },
    })
}

/**
 * Clears the welcome-completed stamp: the nucleus homepage shows the welcome
 * wizard again on the next load (the homepage settings menu's "Restart
 * onboarding"). Same upsert shape as completion — idempotent, fails loud.
 * Deliberately keeps displayName: identity is not tour state.
 */
export async function resetWelcomeOnboarding(userId: string): Promise<void> {
  await getDb()
    .insert(userPreference)
    .values({
      userId,
      welcomeCompletedAt: null,
    })
    .onConflictDoUpdate({
      target: userPreference.userId,
      set: {
        welcomeCompletedAt: null,
        updatedAt: new Date(),
      },
    })
}

/**
 * Persists the name given during the boot sequence ("What should I call you?").
 * Upsert on user_preference — idempotent, fails loud: a silently lost name would
 * ask again forever or greet a stranger. It is also the person's account name
 * (user.name / first / last): members, messages, Drive and the shell show it,
 * whatever happens later in the onboarding (Skip keeps it).
 */
export async function setWelcomeDisplayName(userId: string, name: string): Promise<void> {
  const displayName = name.trim()
  if (!displayName) {
    throw new Error('Name must not be empty.')
  }

  await getDb()
    .insert(userPreference)
    .values({
      userId,
      displayName,
    })
    .onConflictDoUpdate({
      target: userPreference.userId,
      set: {
        displayName,
        updatedAt: new Date(),
      },
    })
  await setAccountName(userId, displayName)
}

/** Writes a display name to the account (user.name + first/last name). */
export async function setAccountName(userId: string, name: string): Promise<void> {
  const fields = normalizeUserNameFields({ name })
  if (!fields.name) throw new Error('Name must not be empty.')
  await authDb
    .update(user)
    .set({ name: fields.name, firstName: fields.firstName ?? null, lastName: fields.lastName ?? null })
    .where(eq(user.id, userId))
}
