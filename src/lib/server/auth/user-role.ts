import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { isAdminRole, type MemberRole } from './roles'

export { MEMBER_ROLES, isAdminRole, type MemberRole } from './roles'

/** The user's company role, or null when there is no such user. */
export async function getUserRole(userId: string): Promise<MemberRole | null> {
  const [row] = await authDb.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.role ?? null
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  return isAdminRole(await getUserRole(userId))
}
