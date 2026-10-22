import { and, eq } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { userApiKey } from '$lib/server/db/schema'

/** Whether the owner left "MCP access" on for this (active) key (migration 0098). */
export async function canUseMcp(keyId: string): Promise<boolean> {
  const [row] = await getDb()
    .select({ mcp: userApiKey.mcp })
    .from(userApiKey)
    .where(and(eq(userApiKey.id, keyId), eq(userApiKey.isActive, true)))
    .limit(1)
  return row?.mcp === true
}
