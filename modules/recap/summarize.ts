import type { KernelEvent } from '$lib/kernel/events'
import { RECAP_EVENT_TYPES, RECAP_PAYLOAD_FIELDS, type RecapEventType } from './types'

/**
 * Deterministic aggregation over window-scoped kernel events. NO LLM (v0) —
 * the same window always produces the same summary. Only whitelisted metadata
 * fields (RECAP_PAYLOAD_FIELDS) are ever quoted; every other payload field
 * (message text, reply text, errors, chat/user ids, spend) is dropped before
 * rendering, so nothing content-bearing can leak into the recap.
 */

export type RecapSummary = {
  headline: string
  lines: string[]
}

/** Optional notable signals that are not kernel events (separate tables). */
export type RecapExtras = {
  /** Open approval requests at recap time (kernel_approvals, status='pending'). */
  pendingApprovals?: number
}

const RECAP_TYPE_ORDER: readonly string[] = RECAP_EVENT_TYPES

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return {}
  return payload as Record<string, unknown>
}

/** Whitelisted-field gate: a value is quotable only if the field is whitelisted AND scalar. */
function whitelistedField(
  record: Record<string, unknown>,
  field: (typeof RECAP_PAYLOAD_FIELDS)[number],
): string | number | boolean | undefined {
  const value = record[field]
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  return undefined
}

function countLines(typeCounts: Map<string, number>): string[] {
  const ordered = [...typeCounts.entries()].sort((a, b) => {
    const rankA = RECAP_TYPE_ORDER.indexOf(a[0])
    const rankB = RECAP_TYPE_ORDER.indexOf(b[0])
    // Whitelisted types first (in whitelist order), then unknown types alphabetically.
    if (rankA !== -1 && rankB !== -1) return rankA - rankB
    if (rankA !== -1) return -1
    if (rankB !== -1) return 1
    return a[0].localeCompare(b[0])
  })
  return ordered.map(([type, count]) => `${count} ${type}`)
}

/**
 * Aggregate window-scoped events into a recap. Pure and deterministic:
 * identical inputs (and extras) always produce an identical summary.
 */
export function summarizeEvents(
  events: readonly KernelEvent[],
  extras: RecapExtras = {},
): RecapSummary {
  const total = events.length
  if (total === 0 && (extras.pendingApprovals === undefined || extras.pendingApprovals === 0)) {
    return {
      headline: 'Quiet day — no company activity in the last 24 hours.',
      lines: ['No kernel events in the window.'],
    }
  }

  const typeCounts = new Map<string, number>()
  const budgetExceededAgents = new Set<string>()
  for (const event of events) {
    typeCounts.set(event.type, (typeCounts.get(event.type) ?? 0) + 1)
    const record = payloadRecord(event.payload)
    if (event.type === 'agent.budget_exceeded') {
      const agentId = whitelistedField(record, 'agentId')
      if (agentId !== undefined) budgetExceededAgents.add(String(agentId))
    }
  }

  const lines: string[] = []

  const pending = extras.pendingApprovals ?? 0
  if (pending > 0) {
    lines.push(`Notable: ${pending} approval${pending === 1 ? '' : 's'} pending.`)
  }

  if (budgetExceededAgents.size > 0) {
    const agents = [...budgetExceededAgents].sort().join(', ')
    lines.push(`Notable: spend cap exceeded by agent${budgetExceededAgents.size === 1 ? '' : 's'} ${agents}.`)
  }

  const denied = typeCounts.get('gateway.telegram.denied') ?? 0
  if (denied > 0) {
    lines.push(`Notable: ${denied} denied gateway attempt${denied === 1 ? '' : 's'}.`)
  }

  lines.push(...countLines(typeCounts))

  const headline = `Daily recap: ${total} kernel event${total === 1 ? '' : 's'} in the last 24 hours.`
  return { headline, lines }
}

/** Type-count projection for the recap.completed event payload (metadata only). */
export function recapTypeCounts(events: readonly KernelEvent[]): Record<RecapEventType, number> {
  const counts = Object.fromEntries(RECAP_EVENT_TYPES.map((type) => [type, 0])) as Record<
    RecapEventType,
    number
  >
  for (const event of events) {
    if ((RECAP_EVENT_TYPES as readonly string[]).includes(event.type)) {
      counts[event.type as RecapEventType] += 1
    }
  }
  return counts
}
