import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { ACTIVITY_PAGE_LLM_PROVIDERS } from '$lib/server/activity/gateway-providers'
import { loadOwnerLog } from '$lib/server/activity/owner-log'

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  // The owner's readable log: plain lines grouped by day, filterable by module.
  const { log, modules, module } = await loadOwnerLog(event.url.searchParams.get('module'))

  return {
    user: event.locals.user,
    gatewayProviders: [...ACTIVITY_PAGE_LLM_PROVIDERS],
    log,
    modules,
    module,
    calls: [],
    groups: undefined,
    totals: { baseCostUsd: '0.000000', markupUsd: '0.000000', totalCostUsd: '0.000000' },
    overallTotals: { baseCostUsd: '0.000000', markupUsd: '0.000000', totalCostUsd: '0.000000' },
    spendSeries: null,
    from: null,
    to: null,
    pagination: {
      page: 1,
      pageSize: 20,
      totalCount: 0,
      totalPages: 1,
      hasPrev: false,
      hasNext: false,
    },
  }
}
