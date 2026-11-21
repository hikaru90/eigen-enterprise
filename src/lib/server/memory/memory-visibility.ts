import { and, eq, isNotNull, ne } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import { canonicalEntity, type MemoryVisibility, type SystemProjectKey } from '$lib/server/db/schema'
import { ownerNameOf } from '$lib/server/memory/memory-owners'
import { MemoryReadOnlyError } from '$lib/server/memory/memory-read-only'
import { reconcileProjectKeys } from '$lib/server/memory/shared-memory-keys'

/**
 * Who may read a project, and who may change it (plan/shared-memory-voice-agent-tools.md §1):
 * every member reads a 'company' project and its tasks; a 'private' one is
 * its owner's alone, no admin or owner override (RLS, drizzle/0164). Only the
 * owner changes a project — colleagues get it read-only.
 */
export type ProjectAccess = {
  entityId: string
  ownerId: string
  ownerName: string
  visibility: MemoryVisibility
  systemKey: SystemProjectKey | null
  /** The reader owns it. */
  editable: boolean
}

/** The reader's view of one project, or null when it does not exist for them (absent, private, not a project). */
export async function resolveProjectAccess(
  readerId: string,
  entityId: string,
): Promise<ProjectAccess | null> {
  const [row] = await getDb()
    .select({
      userId: canonicalEntity.userId,
      visibility: canonicalEntity.visibility,
      systemKey: canonicalEntity.systemKey,
    })
    .from(canonicalEntity)
    .where(
      and(
        eq(canonicalEntity.id, entityId),
        isNotNull(canonicalEntity.projectStatus),
        ne(canonicalEntity.projectStatus, 'dismissed'),
      ),
    )
    .limit(1)
  if (!row) return null
  return {
    entityId,
    ownerId: row.userId,
    ownerName: await ownerNameOf(row.userId),
    visibility: row.visibility,
    systemKey: row.systemKey ?? null,
    editable: row.userId === readerId,
  }
}

/**
 * Write a project's visibility and re-seal its tasks to match. Owner only (the
 * WHERE and RLS both pin the owner): throws when it is not the person's own.
 */
export async function applyProjectVisibility(
  userId: string,
  entityId: string,
  visibility: MemoryVisibility,
): Promise<void> {
  const [updated] = await getDb()
    .update(canonicalEntity)
    .set({ visibility })
    .where(and(eq(canonicalEntity.id, entityId), eq(canonicalEntity.userId, userId)))
    .returning({ id: canonicalEntity.id })
  if (!updated) throw new Error('Project not found or not owned by user')
  await reconcileProjectKeys(userId, entityId)
}

export class ProjectVisibilityError extends Error {}

/**
 * Make a project private (its owner only, no override) or share it with every
 * member. Its owner only; the company's Roadmap is always shared. Its tasks are
 * re-sealed with the matching key in the same step.
 */
export async function setProjectVisibility(
  userId: string,
  entityId: string,
  visibility: MemoryVisibility,
): Promise<{ entityId: string; visibility: MemoryVisibility }> {
  const access = await resolveProjectAccess(userId, entityId)
  if (!access) throw new Error('Project not found')
  if (!access.editable) throw new MemoryReadOnlyError('project', access.ownerName)
  if (access.systemKey) {
    throw new ProjectVisibilityError('The Roadmap is the company’s project: it is always shared with everyone.')
  }
  await applyProjectVisibility(userId, entityId, visibility)
  return { entityId, visibility }
}

/** Throws MemoryReadOnlyError when the project is a colleague's (writes are its owner's). */
export async function assertOwnProject(userId: string, entityId: string): Promise<void> {
  const access = await resolveProjectAccess(userId, entityId)
  if (access && !access.editable) throw new MemoryReadOnlyError('project', access.ownerName)
}
