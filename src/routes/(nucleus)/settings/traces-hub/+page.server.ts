import type { PageServerLoad } from './$types'
import { error } from '@sveltejs/kit'
import { requireCapability } from '$lib/server/auth/require-capability'
import { hubStats, statsInput } from '../../../../../modules/traces/hub/service'
import { STATS_GROUPS, type StatsGroup } from '../../../../../modules/traces/hub/store'

/**
 * The makers' hub page (plan/traces-phone-home.md T4): what every box shared — error rate and
 * p95 by tool, model or version over the last 30 days. Only where the trace-hub module is on;
 * the same read as trace_hub.stats.
 */
export const load: PageServerLoad = async ({ locals, url }) => {
  await requireCapability(locals, 'company.manage', 'Only the owner or an admin can read the product signals hub.')
  const { traceHubActive, traceHubReadDeps } = await import('../../../../../modules/traces/hub/live')
  if (!(await traceHubActive())) error(404, 'This server is not the product signals hub.')
  const by = url.searchParams.get('by')
  const groupBy: StatsGroup = (STATS_GROUPS as readonly string[]).includes(by ?? '') ? (by as StatsGroup) : 'tool'
  return { groupBy, groups: STATS_GROUPS, ...(await hubStats(await traceHubReadDeps(), statsInput.parse({ group_by: groupBy, days: 30 }))) }
}
