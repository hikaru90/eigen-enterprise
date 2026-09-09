import { and, count, desc, eq, gte, lt } from 'drizzle-orm'
import type { KernelEvent } from '$lib/kernel/events'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelGatewaySessions } from '$lib/server/db/gateway.schema'
import { kernelApprovals, kernelEvents } from '$lib/server/db/kernel.schema'
import { RECAP_PLATFORM, type AllowlistReader } from './types'

/**
 * Recap read-model: small direct queries against the kernel_events /
 * kernel_approvals / kernel_gateway_sessions tables (no cross-module imports —
 * the drizzle schema lives in the server db layer, which modules may use).
 * Read-only; every function is pure w.r.t. the injected db handle.
 */

/** Safety cap so a runaway event day cannot blow up the recap run. */
const MAX_WINDOW_EVENTS = 5000

export type RecapWindow = {
  /** Inclusive window start (typically now − 24h). */
  start: Date
  /** Exclusive window end (typically now). */
  end: Date
}

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

/** Kernel events in [start, end), oldest-first (cap: newest 5000, reversed). */
export async function listRecapWindowEvents(
  db: AppDatabase,
  window: RecapWindow,
): Promise<KernelEvent[]> {
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
    .where(and(gte(kernelEvents.ts, window.start), lt(kernelEvents.ts, window.end)))
    .orderBy(desc(kernelEvents.ts))
    .limit(MAX_WINDOW_EVENTS)
  return rows.map(rowToKernelEvent).reverse()
}

/** Open approval requests (kernel_approvals.status = 'pending'). */
export async function countPendingApprovals(db: AppDatabase): Promise<number> {
  const rows = await db
    .select({ pending: count() })
    .from(kernelApprovals)
    .where(eq(kernelApprovals.status, 'pending'))
  return rows[0]?.pending ?? 0
}

/**
 * Owner chats for delivery: Telegram gateway sessions whose principal is
 * currently allowlisted (session × allowlist intersection on principalId —
 * no chatId≈userId assumption). Sorted + deduped for determinism.
 */
export async function listTelegramOwnerChats(
  db: AppDatabase,
  allowlist: AllowlistReader,
): Promise<string[]> {
  const sessions = await db
    .select({
      externalChatId: kernelGatewaySessions.externalChatId,
      principalId: kernelGatewaySessions.principalId,
    })
    .from(kernelGatewaySessions)
    .where(eq(kernelGatewaySessions.platform, RECAP_PLATFORM))

  const entries = await allowlist.list()
  const allowedPrincipals = new Set(
    entries.filter((entry) => entry.platform === RECAP_PLATFORM).map((entry) => entry.principalId),
  )

  const chats = new Set<string>()
  for (const session of sessions) {
    if (allowedPrincipals.has(session.principalId)) chats.add(session.externalChatId)
  }
  return [...chats].sort()
}
