import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { ACTIVITY_PAGE_LLM_PROVIDERS } from '$lib/server/activity/gateway-providers'
import { FEED_EVENT_TYPES, listKernelEvents } from '$lib/server/activity/kernel-events'
import { getDb } from '$lib/server/db'
import {
  groupLogByDay,
  moduleLabel,
  toLogEntry,
  toolNamespaceLabels,
} from '$lib/server/activity/readable-log'
import { appKernel } from '$lib/server/boot'
import { ORCHESTRATOR_AGENT_ID } from '../../../../../modules/orchestrator/brain'

export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  // Company feed: newest kernel events (agent + tool + gateway),
  // projected to metadata-only render items. Read-only on kernel_events.
  const feed = await listKernelEvents(getDb(), { types: [...FEED_EVENT_TYPES], limit: 200 })

  // The owner's readable log: plain lines grouped by day, filterable by module.
  const agentIds = new Set([ORCHESTRATOR_AGENT_ID])
  const namespaces = toolNamespaceLabels((await appKernel()).modules.list())
  const entries = feed.map((event) => toLogEntry(event, agentIds, namespaces))
  const moduleIds = [...new Set(entries.map((e) => e.module))].sort()
  const selected = event.url.searchParams.get('module')
  const module = selected && moduleIds.includes(selected) ? selected : null
  const log = groupLogByDay(module ? entries.filter((e) => e.module === module) : entries)

  return {
    user: event.locals.user,
    gatewayProviders: [...ACTIVITY_PAGE_LLM_PROVIDERS],
    log,
    modules: moduleIds.map((id) => ({ id, label: moduleLabel(id) })),
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
