import { eq } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { userPreference } from '$lib/server/db/schema'

/**
 * The language a person reads generated text in: their preferred language (Settings). No
 * preference row yet means the column's default, English — the same the app shell shows
 * (src/routes/+layout.server.ts).
 */
export async function userOutputLanguage(userId: string): Promise<string> {
  const [row] = await getDb()
    .select({ language: userPreference.preferredLanguage })
    .from(userPreference)
    .where(eq(userPreference.userId, userId))
    .limit(1)
  return row?.language ?? 'en'
}
