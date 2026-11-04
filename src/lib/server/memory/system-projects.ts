import { and, eq, isNotNull, sql, type SQL } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import {
  canonicalEntity,
  thought,
  thoughtEntity,
  type SystemProjectKey,
} from '$lib/server/db/schema'

/**
 * System projects (P-4, drizzle/0120): Memory projects the company itself
 * keeps — today only the "Roadmap" (system_key 'roadmap'), created by
 * roadmap_ensure_project(). They are pinned in Memory and can't be dismissed
 * or deleted by accident: dismiss, entity delete and "delete all memories"
 * refuse or keep them.
 */
export class SystemProjectError extends Error {
  constructor(label: string) {
    super(`“${label}” is a system project of the company: it can't be dismissed or deleted.`)
  }
}

/** The system key of a project entity in this Memory, or null for an ordinary entity. */
export async function systemProjectOf(
  userId: string,
  entityId: string,
): Promise<{ key: SystemProjectKey; label: string } | null> {
  const [row] = await getDb()
    .select({ key: canonicalEntity.systemKey, label: canonicalEntity.label })
    .from(canonicalEntity)
    .where(and(eq(canonicalEntity.userId, userId), eq(canonicalEntity.id, entityId)))
    .limit(1)
  return row?.key ? { key: row.key, label: row.label } : null
}

/** Throws SystemProjectError when the entity is a system project. */
export async function assertNotSystemProject(userId: string, entityId: string): Promise<void> {
  const system = await systemProjectOf(userId, entityId)
  if (system) throw new SystemProjectError(system.label)
}

/**
 * SQL condition: the thought is not a task of a system project. Personal
 * task lists leave the company's Roadmap tasks to its board; "delete all
 * memories" keeps them.
 */
export function notSystemProjectTask(userId: string): SQL {
  return sql`${thought.id} not in (
    select te.thought_id from thought_entity te
    join canonical_entity ce on ce.id = te.entity_id
    where te.user_id = ${userId} and ce.system_key is not null)`
}

/** Ids of thoughts that are tasks of a system project in this Memory (kept by bulk deletes). */
export async function systemProjectThoughtIds(userId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ thoughtId: thoughtEntity.thoughtId })
    .from(thoughtEntity)
    .innerJoin(canonicalEntity, eq(canonicalEntity.id, thoughtEntity.entityId))
    .where(and(eq(thoughtEntity.userId, userId), isNotNull(canonicalEntity.systemKey)))
  return rows.map((row) => row.thoughtId)
}
