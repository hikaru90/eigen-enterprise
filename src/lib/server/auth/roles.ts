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

/**
 * A member's KERNEL roles — what the company brain may do as them (CB3: the
 * person's rights, never more). Every member holds 'member' (the tools of
 * their own Memory, Drive, calendar, contacts, messages, calls, Contribute);
 * owner and admins also hold 'admin' (everything that runs the company). The
 * kernel 'owner' role stays off this list, as on every other person-facing
 * surface (MCP, routes): owner-only tools (Telegram links, switching the agent
 * on/off) are the owner's own clicks, never the brain's.
 */
export function kernelRolesFor(role: MemberRole): string[] {
  return isAdminRole(role) ? ['admin', 'member'] : ['member']
}
