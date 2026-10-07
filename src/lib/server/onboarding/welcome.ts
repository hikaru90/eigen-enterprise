import { getDb } from '$lib/server/db'
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
