import { FEED_EVENT_TYPES, listKernelEvents } from '$lib/server/activity/kernel-events'
import {
  groupLogByDay,
  moduleLabel,
  toLogEntry,
  toolNamespaceLabels,
  type ActivityLogDay,
} from '$lib/server/activity/readable-log'
import { appKernel } from '$lib/server/boot'
import { getDb } from '$lib/server/db'
import { ORCHESTRATOR_AGENT_ID } from '../../../../modules/orchestrator/brain'

export type OwnerLog = {
  log: ActivityLogDay[]
  modules: Array<{ id: string; label: string }>
  /** The module filter that applied (null = all; an unknown id is ignored). */
  module: string | null
}

/**
 * The owner's readable activity log: the newest whitelisted kernel events
 * (agent + tool + gateway) as plain lines grouped by day, filterable by
 * module. Read-only on kernel_events. Shared by /assistant/activity and the
 * assistant panel's Activity tab (GET /api/assistant/activity).
 */
export async function loadOwnerLog(selected: string | null, limit = 200): Promise<OwnerLog> {
  const feed = await listKernelEvents(getDb(), { types: [...FEED_EVENT_TYPES], limit })
  const agentIds = new Set([ORCHESTRATOR_AGENT_ID])
  const namespaces = toolNamespaceLabels((await appKernel()).modules.list())
  const entries = feed.map((event) => toLogEntry(event, agentIds, namespaces))
  const moduleIds = [...new Set(entries.map((e) => e.module))].sort()
  const module = selected && moduleIds.includes(selected) ? selected : null
  return {
    log: groupLogByDay(module ? entries.filter((e) => e.module === module) : entries),
    modules: moduleIds.map((id) => ({ id, label: moduleLabel(id) })),
    module,
  }
}
