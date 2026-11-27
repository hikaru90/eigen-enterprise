import { eq } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { userPreference } from '$lib/server/db/schema'

/**
 * "Share where I am" (plan/phase-multiplayer-presence.md), stored per person
 * in user_preference.share_where — the only stored part of presence. No
 * preference row yet = on (the column's default); switching writes the row.
 * Company-level reads (no RLS on user_preference): the tracker learns
 * everyone's switch outside any request.
 */
export type ShareWhereStore = {
  /** Everyone who switched it off. */
  offIds(): Promise<string[]>
  set(userId: string, on: boolean): Promise<void>
}

export function dbShareWhereStore(db: AppDatabase): ShareWhereStore {
  return {
    async offIds() {
      const rows = await db
        .select({ userId: userPreference.userId })
        .from(userPreference)
        .where(eq(userPreference.shareWhere, false))
      return rows.map((r) => r.userId)
    },
    async set(userId, on) {
      await db
        .insert(userPreference)
        .values({ userId, shareWhere: on })
        .onConflictDoUpdate({ target: userPreference.userId, set: { shareWhere: on, updatedAt: new Date() } })
    },
  }
}
