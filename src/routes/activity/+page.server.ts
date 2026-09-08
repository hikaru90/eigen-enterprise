import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { ACTIVITY_PAGE_LLM_PROVIDERS } from '$lib/server/activity/gateway-providers'
import { FEED_EVENT_TYPES, listKernelEvents, toFeedItem } from '$lib/server/activity/kernel-events'
import { getDb } from '$lib/server/db'

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  // Company feed: newest kernel events (agent + tool + gateway + dev-agent),
  // projected to metadata-only render items. Read-only on kernel_events.
  const feed = await listKernelEvents(getDb(), { types: [...FEED_EVENT_TYPES] })

  return {
    user: event.locals.user,
    gatewayProviders: [...ACTIVITY_PAGE_LLM_PROVIDERS],
    feed: feed.map(toFeedItem),
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
