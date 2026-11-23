import type { CoworkerRunRow } from './run-store'
import { actsAsMember } from '$lib/kernel/principals'
import type { ToolPrincipal } from '$lib/kernel/types'

/**
 * A co-worker's run log as a reader sees it (coworkers.runs, C3): every run's
 * trigger, status, cost and timings; where it ran (conversation, thread, the
 * triggering message, the link) only when the reader may see that
 * conversation — a member with their own access (Messages' canUse), anyone
 * else only public channels. A hidden location is null with `hidden: true`.
 *
 * C6: a rhythm run links to the post it made (its thread); an assignment run
 * links to its task — only for the person who gave the task (the task's other
 * side is the co-worker itself), hidden for everyone else.
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
  /** The assigned task an assignment run worked on; null when hidden or not a task. */
  taskId: string | null
  /** The task in Memory › Tasks; null when hidden or not a task. */
  taskUrl: string | null
  /** The rhythm a rhythm run is a slot of. */
  rhythmId: string | null
  /** The run happened in a conversation, or on a task, this reader may not see. */
  hidden: boolean
  triggeredAt: string
  startedAt: string | null
  endedAt: string | null
  error: string | null
}

/** Where the assigner finds a task (Memory › Tasks, its row). */
export const taskUrlOf = (taskId: string) => `/m/memory/tasks#assigned-${encodeURIComponent(taskId)}`

export function runEntry(row: CoworkerRunRow, visible: ReadonlySet<string>, readerId: string): CoworkerRunEntry {
  const shown = row.conversationId !== null && visible.has(row.conversationId)
  const taskShown = row.taskId !== null && row.requestedByUserId === readerId
  const hidden = (row.conversationId !== null && !shown) || (row.taskId !== null && !taskShown)
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
    taskId: taskShown ? row.taskId : null,
    taskUrl: taskShown ? taskUrlOf(row.taskId!) : null,
    rhythmId: row.rhythmId,
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
