// The Assistant activity "Calls" table: grouped by run (groupId) by default;
// sorting a column flattens the groups and sorts every loaded call.
import { sortRows, type SortState } from '$lib/table/sort'

export type ActivityCallRow = {
  id: string
  provider: string
  gatewayHost?: string | null
  operation: string
  context?: string | null
  baseCostUsd: string
  markupUsd: string
  totalCostUsd: string
  groupId?: string | null
  durationMs?: number | null
  createdAt: string | Date
}

export type ActivityCallGroup = {
  key: string
  groupId: string | null
  calls: ActivityCallRow[]
  firstOp: string
  groupTotalUsd: string
}

export type ActivityCallCol = 'when' | 'provider' | 'operation' | 'duration' | 'credits'

export function sumTotalUsd(calls: readonly ActivityCallRow[]): string {
  let total = 0
  for (const c of calls) total += Number(c.totalCostUsd)
  return total.toFixed(6)
}

function endpointLabelFromHost(hostname: string): string {
  const h = hostname
    .trim()
    .toLowerCase()
    .replace(/^www\./, '')
  const parts = h.split('.').filter(Boolean)
  if (parts.length <= 2) return parts[0] ?? h
  return parts[parts.length - 2] ?? parts[0]
}

export function groupProviderLabel(calls: readonly ActivityCallRow[]): {
  label: string
  isPaid: boolean
} {
  const first = calls[0]
  if (first.provider === 'agent') return { label: 'Agent', isPaid: false }
  const host = first.gatewayHost?.trim()
  if (host) return { label: endpointLabelFromHost(host), isPaid: true }
  return { label: 'Gateway', isPaid: true }
}

const group = (key: string, groupId: string | null, calls: ActivityCallRow[]) => ({
  key,
  groupId,
  calls,
  firstOp: calls[0].operation,
  groupTotalUsd: sumTotalUsd(calls),
})

/** Groups by groupId in first-seen order; calls inside a group run oldest first. */
export function groupActivityCalls(calls: readonly ActivityCallRow[]): ActivityCallGroup[] {
  const byKey = new Map<string, ActivityCallRow[]>()
  for (const c of calls) {
    const key = c.groupId ?? `__ungrouped__${c.id}`
    const list = byKey.get(key)
    if (list) list.push(c)
    else byKey.set(key, [c])
  }
  return [...byKey].map(([key, list]) => {
    list.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    return group(key, key.startsWith('__ungrouped__') ? null : key, list)
  })
}

/** No sort: the grouped view. A sorted column: one row per loaded call, sorted. */
export function activityCallRows(
  calls: readonly ActivityCallRow[],
  sort: SortState<ActivityCallCol>,
): ActivityCallGroup[] {
  if (!sort) return groupActivityCalls(calls)
  return sortRows(calls, sort, {
    when: (c) => new Date(c.createdAt),
    provider: (c) => groupProviderLabel([c]).label,
    operation: (c) => c.operation,
    duration: (c) => c.durationMs,
    credits: (c) => Number(c.totalCostUsd),
  }).map((c) => group(`__call__${c.id}`, null, [c]))
}
