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
