import type { PageServerLoad } from './$types'
import { randomUUID } from 'node:crypto'
import { error } from '@sveltejs/kit'
import type { AiUsageOverview } from '$lib/ai-usage/overview'
import { periodOf, periodRange, type AiUsagePeriod } from '$lib/ai-usage/view'
import { requireCapability } from '$lib/server/auth/require-capability'
import type { MemberRole } from '$lib/server/auth/roles'
import { kernelRolesFor } from '$lib/server/auth/user-role'
import { appKernel } from '$lib/server/boot'

/**
 * Settings → AI usage (plan/phase-ai-usage-overview.md §5), owner and admins: a client of
 * settings.ai_usage_overview, run through the registry as the person reading it.
 */

/** Overridable in tests. */
export const _aiUsageDeps = {
  run: async (person: { id: string; role: MemberRole }, input: { from?: string; to?: string }): Promise<AiUsageOverview> => {
    const kernel = await appKernel()
    return (await kernel.registry.execute('settings.ai_usage_overview', input, {
      principal: { id: person.id, kind: 'human', roles: kernelRolesFor(person.role) },
      requestId: randomUUID(),
    })) as AiUsageOverview
  },
}

export const load: PageServerLoad = async ({ locals, url }): Promise<{ period: AiUsagePeriod; overview: AiUsageOverview }> => {
  const { user, role } = await requireCapability(locals, 'ai_usage.view', 'Only the owner or an admin can see the company’s AI usage.')
  const period = periodOf(url.searchParams.get('period'))
  if (period === null) error(400, 'Choose 7, 30 or 90 days, or all.')
  return { period, overview: await _aiUsageDeps.run({ id: user.id, role: role! }, periodRange(period, new Date())) }
}
