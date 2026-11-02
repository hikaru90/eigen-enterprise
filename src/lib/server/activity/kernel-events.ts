import { and, desc, inArray, lt } from 'drizzle-orm'
import { z } from 'zod'
import type { KernelEvent } from '$lib/kernel/events'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelEvents } from '$lib/server/db/kernel.schema'

/**
 * Company feed read-model over the append-only kernel_events table.
 * Read-only — this module never writes. Event types are whitelisted by exact
 * match (no string heuristics); rendered payloads are reduced to a fixed set
 * of metadata fields so message/reply content can never reach the UI.
 */

/**
 * Event types the company feed surfaces — the exact strings emitted across
 * the codebase: kernel/agent-runtime.ts (agent.*), kernel/registry.ts
 * (tool.executed), modules/chat-gateway/telegram.ts (gateway.telegram.*).
 * Single source of truth.
 */
export const FEED_EVENT_TYPES = [
  'agent.dispatched',
  'agent.replied',
  'agent.stopped',
  'agent.budget_exceeded',
  'tool.executed',
  'gateway.telegram.message',
  'gateway.telegram.denied',
] as const

/**
 * The only payload fields the feed may render — metadata only. Anything else
 * in a payload (message text, reply text, chat ids, errors, spend figures)
 * is dropped by toFeedItem.
 */
export const FEED_PAYLOAD_FIELDS = [
  'tool',
  'auditClass',
  'ok',
  'durationMs',
  'replyLength',
  'agentId',
  'sessionId',
  'runId',
  'green',
] as const

const listInputSchema = z.object({
  /** Exact-match whitelist; unknown types fail loud. */
  types: z.array(z.enum(FEED_EVENT_TYPES)).min(1).optional(),
  limit: z.number().int().positive().max(500).default(50),
  /** Pagination cursor: only events strictly older than this instant. */
  before: z.date().optional(),
})

export type ListKernelEventsInput = z.input<typeof listInputSchema>

type KernelEventRow = {
  id: string
  ts: Date
  type: string
  principalId: string | null
  source: string | null
  payload: unknown
}

function rowToKernelEvent(row: KernelEventRow): KernelEvent {
  return {
    id: row.id,
    ts: row.ts.toISOString(),
    type: row.type,
    ...(row.principalId === null ? {} : { principalId: row.principalId }),
    ...(row.source === null ? {} : { source: row.source }),
    payload: row.payload,
  }
}

/** Newest-first KernelEvent rows. Pure w.r.t. the injected db handle. */
export async function listKernelEvents(
  db: AppDatabase,
  input: ListKernelEventsInput = {},
): Promise<KernelEvent[]> {
  const parsed = listInputSchema.parse(input)
  const conditions = [
    ...(parsed.types ? [inArray(kernelEvents.type, [...parsed.types])] : []),
    ...(parsed.before ? [lt(kernelEvents.ts, parsed.before)] : []),
  ]
  const rows: KernelEventRow[] = await db
    .select({
      id: kernelEvents.id,
      ts: kernelEvents.ts,
      type: kernelEvents.type,
      principalId: kernelEvents.principalId,
      source: kernelEvents.source,
      payload: kernelEvents.payload,
    })
    .from(kernelEvents)
    .where(conditions.length > 0 ? and(...conditions) : undefined)
    .orderBy(desc(kernelEvents.ts))
    .limit(parsed.limit)
  return rows.map(rowToKernelEvent)
}

export type ActivityFeedItem = {
  id: string
  /** Formatted server-side (UTC) so the view stays dumb. */
  tsLabel: string
  type: string
  principalId?: string
  /** Built exclusively from FEED_PAYLOAD_FIELDS — empty when none apply. */
  summary: string
}

function formatFeedTimestamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) {
    throw new Error(`toFeedItem: invalid event timestamp ${JSON.stringify(iso)}`)
  }
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ` +
    `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())} UTC`
  )
}

function feedSummary(payload: unknown): string {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return ''
  }
  const record = payload as Record<string, unknown>
  const parts: string[] = []
  for (const field of FEED_PAYLOAD_FIELDS) {
    const value = record[field]
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${field}=${String(value)}`)
    }
  }
  return parts.join(' ')
}

/**
 * Render-ready, metadata-only projection of one KernelEvent. Content-bearing
 * payload fields (message text, reply text, errors, chat/user ids) are never
 * included — only FEED_PAYLOAD_FIELDS survive.
 */
export function toFeedItem(event: KernelEvent): ActivityFeedItem {
  return {
    id: event.id,
    tsLabel: formatFeedTimestamp(event.ts),
    type: event.type,
    ...(event.principalId === undefined ? {} : { principalId: event.principalId }),
    summary: feedSummary(event.payload),
  }
}
