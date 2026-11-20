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
 */
export async function personFor(userId: string): Promise<PersonRef | null> {
  if (!userId) return null
  const role = await getUserRole(userId)
  return role ? { id: userId, roles: kernelRolesFor(role) } : null
}

/** The live member directory the kernel resolves people through (background runs, Telegram). */
export const memberDirectory: PersonDirectory = { personById: personFor }
