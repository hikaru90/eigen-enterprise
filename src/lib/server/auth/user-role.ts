import { eq } from 'drizzle-orm'
import type { PersonDirectory, PersonRef } from '$lib/kernel/principals'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { isAdminRole, kernelRolesFor, type MemberRole } from './roles'

export { MEMBER_ROLES, isAdminRole, kernelRolesFor, type MemberRole } from './roles'

/** The user's company role, or null when there is no such user. */
export async function getUserRole(userId: string): Promise<MemberRole | null> {
  const [row] = await authDb.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.role ?? null
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  return isAdminRole(await getUserRole(userId))
}

/**
 * The member as a person the company brain acts for: their id and kernel
 * roles (kernelRolesFor), read now — or null when there is no such member.
 * An AI co-worker is no person (plan/phase-ai-coworkers.md §3): it acts as
 * itself (coworkerPrincipal), never through the brain, so it is null here.
 */
export async function personFor(userId: string): Promise<PersonRef | null> {
  if (!userId) return null
  const [row] = await authDb.select({ role: user.role, kind: user.kind }).from(user).where(eq(user.id, userId)).limit(1)
  if (!row || row.kind === 'coworker') return null
  return { id: userId, roles: kernelRolesFor(row.role) }
}

/** The live member directory the kernel resolves people through (background runs, Telegram). */
export const memberDirectory: PersonDirectory = { personById: personFor }
