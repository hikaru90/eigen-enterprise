import { inArray } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { user } from '$lib/server/db/schema'

/**
 * Who owns a shared project or note, as colleagues see it: the owner's display
 * name next to their item (plan/shared-memory-voice-agent-tools.md §1). The
 * user table is readable by every session (enable_rls.sql user_read_all).
 */
export type MemoryOwner = { id: string; name: string }

export async function ownerNamesOf(userIds: string[]): Promise<Map<string, string>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Map()
  const rows = await getDb().select({ id: user.id, name: user.name }).from(user).where(inArray(user.id, ids))
  const names = new Map(rows.map((row) => [row.id, row.name]))
  for (const id of ids) {
    if (!names.has(id)) throw new Error(`memory owner ${id} is no user`)
  }
  return names
}

export async function ownerNameOf(userId: string): Promise<string> {
  return (await ownerNamesOf([userId])).get(userId)!
}

/** Adds `owner` ({ id, name }) to each item by its `ownerId`. */
export async function withOwners<T extends { ownerId: string }>(
  items: T[],
): Promise<Array<T & { owner: MemoryOwner }>> {
  const names = await ownerNamesOf(items.map((item) => item.ownerId))
  return items.map((item) => ({ ...item, owner: { id: item.ownerId, name: names.get(item.ownerId)! } }))
}
