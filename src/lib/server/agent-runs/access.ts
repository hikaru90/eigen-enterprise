import { getUserRole, MEMBER_ROLES } from '$lib/server/auth/user-role'

export type RunViewAccess = { ok: true; userId: string } | { ok: false; status: 401 | 403; error: string }

/**
 * D8 visibility is company-wide, for company members only: a session alone is
 * not enough — the user must hold a member role (owner/admin/member). Fails
 * closed: no user row, or an unknown role, is refused.
 */
export async function runViewAccess(user: { id: string } | null | undefined): Promise<RunViewAccess> {
  if (!user) return { ok: false, status: 401, error: 'Unauthorized' }
  const role = await getUserRole(user.id)
  if (role === null || !(MEMBER_ROLES as readonly string[]).includes(role)) {
    return { ok: false, status: 403, error: 'Forbidden: company members only' }
  }
  return { ok: true, userId: user.id }
}
