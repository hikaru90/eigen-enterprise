import type { ToolPrincipal } from '$lib/kernel/types'
import type { CoworkerRunRow } from './run-store'
import { actsAsMember } from '$lib/kernel/principals'

/**
 * A co-worker's run log as a reader sees it (coworkers.runs, C3): every run's
 * trigger, status, cost and timings; where it ran (conversation, thread, the
 * triggering message, the link) only when the reader may see that
 * conversation — a member with their own access (Messages' canUse), anyone
 * else only public channels. A hidden location is null with `hidden: true`.
 */

export type CoworkerRunEntry = {
  id: string
  triggerKind: CoworkerRunRow['triggerKind']
  status: CoworkerRunRow['status']
  stopReason: CoworkerRunRow['stopReason']
  costUsd: number
  requestedByUserId: string | null
  conversationId: string | null
  threadRootId: string | null
  triggerMessageId: string | null
  /** The thread in Messages (`/messages?c=…&t=…`); null when hidden or not in a conversation. */
  threadUrl: string | null
  /** The run happened in a conversation this reader may not see. */
  hidden: boolean
  triggeredAt: string
  startedAt: string | null
  endedAt: string | null
  error: string | null
}

export function runEntry(row: CoworkerRunRow, visible: ReadonlySet<string>): CoworkerRunEntry {
  const shown = row.conversationId !== null && visible.has(row.conversationId)
  const hidden = row.conversationId !== null && !shown
  return {
    id: row.id,
    triggerKind: row.triggerKind,
    status: row.status,
    stopReason: row.stopReason,
    costUsd: row.costUsd,
    requestedByUserId: row.requestedByUserId,
    conversationId: shown ? row.conversationId : null,
    threadRootId: shown ? row.threadRootId : null,
    triggerMessageId: shown ? row.triggerMessageId : null,
    threadUrl: shown
      ? `/messages?c=${encodeURIComponent(row.conversationId!)}${row.threadRootId ? `&t=${encodeURIComponent(row.threadRootId)}` : ''}`
      : null,
    hidden,
    triggeredAt: row.triggeredAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
    error: row.error,
  }
}

/** Live: Messages decides who may see a conversation. */
export async function liveRunLocations(reader: ToolPrincipal, conversationIds: string[]): Promise<Set<string>> {
  const [{ messagesDeps }, { canUse }] = await Promise.all([import('../../../../modules/messages/live'), import('../../../../modules/messages/service')])
  const d = await messagesDeps()
  const out = new Set<string>()
  for (const id of new Set(conversationIds)) {
    const c = await d.store.getConversation(id)
    if (!c) continue
    const may = actsAsMember(reader) ? await canUse(d, reader.id, c) : c.kind === 'channel' && !c.private && !c.archived
    if (may) out.add(id)
  }
  return out
}
