import { error, redirect } from '@sveltejs/kit'
import type { Capabilities, Capability } from '$lib/access/capabilities'
import { capabilitiesFor, roleCan } from '$lib/server/auth/capabilities'
import type { MemberRole } from '$lib/server/auth/roles'
import { getUserRole } from '$lib/server/auth/user-role'

/** The signed-in person's capability set (the shell's, src/routes/(nucleus)/+layout.server.ts). */
export async function userCapabilities(userId: string): Promise<Capabilities> {
  return capabilitiesFor(await getUserRole(userId))
}

/**
 * Route guard: signed out → /login; without the capability → 403 with the
 * reason (the error page shows the human "no access" page for every 403).
 */
export async function requireCapability(
  locals: App.Locals,
  capability: Capability,
  reason: string,
): Promise<{ user: NonNullable<App.Locals['user']>; role: MemberRole | null }> {
  const user = locals.user
  if (!user) throw redirect(302, '/login')
  const role = await getUserRole(user.id)
  if (!roleCan(role, capability)) error(403, reason)
  return { user, role }
}
