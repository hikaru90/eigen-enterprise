import { and, isNotNull, sql } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { memberInvite } from '$lib/server/db/auth.schema'
import type { MemberRole } from '$lib/server/auth/user-role'
import { joinedByOpenJoin } from './open-join-db'

/** Whether this account came in through a member invite (an accepted invite for its email). */
export async function joinedByInvite(email: string): Promise<boolean> {
  const rows = await authDb
    .select({ id: memberInvite.id })
    .from(memberInvite)
    .where(and(sql`lower(${memberInvite.email}) = ${email.trim().toLowerCase()}`, isNotNull(memberInvite.acceptedAt)))
    .limit(1)
  return rows.length > 0
}

/**
 * Whether this account joined an existing company — an accepted invite, or
 * open join (members.open_join) — rather than founding one.
 */
export async function joinedTheCompany(account: { id: string; email: string }): Promise<boolean> {
  if (await joinedByInvite(account.email)) return true
  return joinedByOpenJoin(account.id)
}

/**
 * Who gets the company onboarding (tour, provider setup) on `/`: the owner;
 * an invited admin only while the company has no working provider yet; an
 * invited member never — they gave their name on the invite page and go
 * straight into the app. An account that signed up on its own (an open dev
 * install, no invite) is founding the company and keeps the onboarding.
 */
export function companyOnboardingFor(input: { role: MemberRole | null; invited: boolean; providerReady: boolean }): boolean {
  if (input.role === 'owner' || !input.invited) return true
  return input.role === 'admin' && !input.providerReady
}
