/**
 * Company roles (user.role) and what they mean — no database here, so the
 * capability rules (capabilities.ts) can be imported anywhere. Reading a
 * person's role is user-role.ts.
 */

/** One owner; admins manage members like the owner does; members use the company. */
export const MEMBER_ROLES = ['owner', 'admin', 'member'] as const
export type MemberRole = (typeof MEMBER_ROLES)[number]

/** Owner and admins run the company (settings, agent, members). */
export function isAdminRole(role: MemberRole | null): boolean {
  return role === 'owner' || role === 'admin'
}
