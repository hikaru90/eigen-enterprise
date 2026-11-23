import type { ConversationKind, Person } from '../../../../modules/messages/store'
import { mentionedIds } from '../../../../modules/messages/notify'

/**
 * When a new message asks an AI co-worker for a turn (plan/phase-ai-coworkers.md
 * §6, C3) — structure, never meaning: an `@handle` token (the co-worker's slug,
 * modules/messages/notify.ts) or DM membership.
 *
 * - Never its own message, a deleted one or a call line.
 * - A channel: the message @mentions it ('mention').
 * - A DM it is in: a person's message ('dm'); another co-worker's message only
 *   when it @mentions it ('mention') — two co-workers in a group DM never
 *   answer each other just because they share it.
 *
 * Whether the co-worker may post in the conversation is the caller's check
 * (canUse 'edit'); the thread a turn answers in is `threadRootOf`.
 */

export type TriggerMessage = {
  id: string
  authorId: string
  body: string
  parentId: string | null
  deleted: boolean
  /** A call line ("Call, 4 min") is never a request. */
  isCallLine: boolean
}

export type MessageTriggerKind = 'mention' | 'dm'

export function coworkerTriggerFor(input: {
  coworkerId: string
  message: TriggerMessage
  conversationKind: ConversationKind
  people: readonly Person[]
}): MessageTriggerKind | null {
  const { coworkerId, message } = input
  if (message.authorId === coworkerId || message.deleted || message.isCallLine) return null
  const mentioned = mentionedIds(message.body, input.people).includes(coworkerId)
  if (input.conversationKind === 'channel') return mentioned ? 'mention' : null
  const author = input.people.find((p) => p.id === message.authorId)
  // A former member's message (no longer in the directory) asks nobody.
  if (!author) return null
  if (author.kind === undefined) throw new Error(`the people directory gives no kind (human | coworker) for ${author.id}`)
  if (author.kind === 'human') return 'dm'
  return mentioned ? 'mention' : null
}

/**
 * The thread a turn answers in: a reply's thread; in a channel, a top-level
 * message opens its own thread; in a DM, a top-level message is answered in the
 * DM's main log (null).
 */
export function threadRootOf(message: Pick<TriggerMessage, 'id' | 'parentId'>, conversationKind: ConversationKind): string | null {
  if (message.parentId) return message.parentId
  return conversationKind === 'channel' ? message.id : null
}

/** One durable conversation per co-worker and thread: `coworker:<coworkerId>:<conversationId>:<threadRootId | main>`. */
export function coworkerSessionId(coworkerId: string, conversationId: string, threadRootId: string | null): string {
  return `coworker:${coworkerId}:${conversationId}:${threadRootId ?? 'main'}`
}

/** A rhythm run's own durable conversation (C6): `coworker:<coworkerId>:run:<runId>` — each check-in starts fresh, its channel log is the context. */
export function coworkerRunSessionId(coworkerId: string, runId: string): string {
  return `coworker:${coworkerId}:run:${runId}`
}

/** One durable conversation per co-worker and assigned task (C6): `coworker:<coworkerId>:task:<taskId>` — a follow-up continues it. */
export function coworkerTaskSessionId(coworkerId: string, taskId: string): string {
  return `coworker:${coworkerId}:task:${taskId}`
}

/** The trigger keys of work runs (coworker_run.trigger_key, unique per co-worker): structure the queue writes and reads back. */
export const TASK_ASSIGNED_KEY = 'task:'
export const TASK_COMMENT_KEY = 'task-comment:'
export const taskAssignedKey = (taskId: string) => `${TASK_ASSIGNED_KEY}${taskId}`
export const taskCommentKey = (commentId: string) => `${TASK_COMMENT_KEY}${commentId}`
