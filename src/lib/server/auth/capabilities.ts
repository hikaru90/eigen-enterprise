import { CAPABILITIES, type Capabilities, type Capability } from '$lib/access/capabilities'
import { isAdminRole, type MemberRole } from '$lib/server/auth/roles'

/**
 * The one place a company role becomes a capability. The route guards ask
 * the same rules (roleCan, requireCapability in require-capability.ts) and
 * the shell gets the whole set (capabilitiesFor), so what the UI offers and
 * what the server allows cannot drift. The Website and Brand pages guard with
 * requireAdmin (require-admin.ts), which is isAdminRole — the rule below;
 * src/routes/(nucleus)/role-aware.spec.ts runs those guards against this set.
 * No database here: safe to import anywhere on the server.
 */
const RULES: Record<Capability, (role: MemberRole | null) => boolean> = {
  'company.manage': isAdminRole,
  'members.manage': isAdminRole,
  'approvals.manage': isAdminRole,
  // The recovery code unlocks every backup: the owner's alone (D11).
  'backups.manage': (role) => role === 'owner',
  'website.manage': isAdminRole,
  'brand.extract': isAdminRole,
}

export function roleCan(role: MemberRole | null, capability: Capability): boolean {
  return RULES[capability](role)
}

/** Every capability for a role (null = no member: nothing). */
export function capabilitiesFor(role: MemberRole | null): Capabilities {
  return Object.fromEntries(CAPABILITIES.map((c) => [c, roleCan(role, c)])) as Record<Capability, boolean>
}
