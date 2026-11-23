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

/** Whose thought it is, as a reader sees it: name and kind (a person, or an AI co-worker; plan/phase-ai-coworkers.md §7). */
export type ThoughtOwner = { id: string; name: string; kind: 'human' | 'coworker' }

export async function thoughtOwnersOf(userIds: string[]): Promise<Map<string, ThoughtOwner>> {
  const ids = [...new Set(userIds)]
  if (ids.length === 0) return new Map()
  const rows = await getDb()
    .select({ id: user.id, name: user.name, kind: user.kind })
    .from(user)
    .where(inArray(user.id, ids))
  const owners = new Map(rows.map((row) => [row.id, { id: row.id, name: row.name, kind: row.kind }]))
  for (const id of ids) {
    if (!owners.has(id)) throw new Error(`memory owner ${id} is no user`)
  }
  return owners
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
