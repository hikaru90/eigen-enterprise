import { eq } from 'drizzle-orm'
import { parseHiddenTiles, type TileId } from '$lib/dashboard/tiles'
import { getDb } from '$lib/server/db'
import { userPreference } from '$lib/server/db/schema'

/**
 * The dashboard tiles a person closed (Contribute 06894ad7), per user so they
 * stay hidden on every device. No preference row yet = nothing closed.
 */
export async function getHiddenTiles(userId: string): Promise<TileId[]> {
  const [row] = await getDb()
    .select({ hidden: userPreference.dashboardHiddenTiles })
    .from(userPreference)
    .where(eq(userPreference.userId, userId))
    .limit(1)
  if (!row) return []
  const parsed = parseHiddenTiles(row.hidden)
  if (!parsed.ok) throw new Error(`user_preference.dashboard_hidden_tiles for ${userId}: ${parsed.error}`)
  return parsed.hidden
}

export async function saveHiddenTiles(userId: string, hidden: readonly TileId[]): Promise<void> {
  await getDb()
    .insert(userPreference)
    .values({ userId, dashboardHiddenTiles: [...hidden] })
    .onConflictDoUpdate({
      target: userPreference.userId,
      set: { dashboardHiddenTiles: [...hidden], updatedAt: new Date() },
    })
}
