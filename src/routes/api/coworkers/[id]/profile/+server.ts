import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import type { AiUsageOverview } from '$lib/ai-usage/overview'
import type { CoworkerProfilePayload } from '$lib/coworkers/profile'
import { periodOf, periodRange } from '$lib/ai-usage/view'
import type { MemberRole } from '$lib/server/auth/roles'
import type { CoworkerView } from '$lib/server/coworkers/service'
import { personRun, type PersonRunner } from '$lib/server/org/person-run'

/**
 * An AI co-worker's profile for the panel in Messages (wish 7c6db153): what
 * the profile page shows at a glance, read through the registry as the signed-in
 * person — coworkers.get for everyone; for the owner and admins also its AI usage
 * of the period (?usage=7|30|90|all, wish acdb941e: settings.ai_usage_overview
 * with user_id) and `canManage`, which offers the edit path (Settings →
 * Co-workers). No action of its own: a thin client of two read tools.
 */


/** Overridable in tests. */
export const _coworkerProfileDeps: { run: PersonRunner; role: (userId: string) => Promise<MemberRole | null>; now: () => Date } = {
  run: personRun,
  role: async (userId) => (await import('$lib/server/auth/user-role')).getUserRole(userId),
  now: () => new Date(),
}

export const GET: RequestHandler = async ({ locals, params, url }) => {
  const user = locals.user
  if (!user) error(401, 'You must be signed in.')
  const period = periodOf(url.searchParams.get('usage'))
  if (period === null) error(400, 'Choose 7, 30 or 90 days, or all.')
  const d = _coworkerProfileDeps
  const { roleCan } = await import('$lib/server/auth/capabilities')
  const canManage = roleCan(await d.role(user.id), 'coworkers.manage')
  const [coworker, overview] = await Promise.all([
    d.run<CoworkerView>(user, 'coworkers.get', { user_id: params.id }),
    canManage ? d.run<AiUsageOverview>(user, 'settings.ai_usage_overview', { ...periodRange(period, d.now()), user_id: params.id }) : null,
  ])
  const body: CoworkerProfilePayload = {
    coworker,
    canManage,
    usage: overview ? { amounts: overview.people.length > 0 ? overview.totals : null, billing: overview.billing, period } : null,
  }
  return json(body)
}
