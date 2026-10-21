import { eq } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'

/** Company roles (user.role): one owner; admins manage members like the owner does; members use the company. */
export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

/** The user's company role, or null when there is no such user. */
export async function getUserRole(userId: string): Promise<MemberRole | null> {
  const [row] = await authDb.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1)
  return row?.role ?? null
}

/** Owner and admins run the company (settings, agent, members). */
export function isAdminRole(role: MemberRole | null): boolean {
  return role === 'owner' || role === 'admin'
}

export async function isUserAdmin(userId: string): Promise<boolean> {
  return isAdminRole(await getUserRole(userId))
}
