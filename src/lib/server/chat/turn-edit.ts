import { and, asc, eq, gte, ne, sql } from 'drizzle-orm'
import type { getDb } from '$lib/server/db'
import { chatMessage } from '$lib/server/db/brain.schema'

/**
 * Edit-and-resend in the chat transcript (board a950ef11: "after stopping the
 * reply I can't edit my message"). The person's LATEST message can be edited
 * and sent again: the old message and everything after it (a stopped or
 * finished reply, tool lines) are superseded — kept in chat_message as
 * history, marked structurally in `metadata`, and left out of what the chat
 * shows. The model side does the same in the durable transcript
 * (AgentRuntime.supersedeTurn), so what the person sees is what the model sees.
 *
 * Marks (all in chat_message.metadata, no schema change):
 * - `supersededBy: <new user message id>` on every row of the replaced turn;
 * - `turnOf: <user message id>` on the assistant rows a turn writes, so a reply
 *   that lands after the edit (the stopped run finished anyway) is still
 *   recognised as part of the superseded turn;
 * - `replaces: <old user message id>` on the new user message.
 */

/** The fixed words the person reads when their message cannot be edited (any reason). */
export { TURN_NOT_EDITABLE_MESSAGE } from '$lib/chat/chat-stream-types'

/** Why an edit was refused (operator logs; the person reads TURN_NOT_EDITABLE_MESSAGE). */
export class TurnNotEditableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TurnNotEditableError'
  }
}

export type TranscriptRow = {
  id: string
  role: 'user' | 'assistant' | 'system'
  metadata?: Record<string, unknown> | null
}

function stringField(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const value = metadata?.[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The rows the chat shows (and the next edit reasons about): superseded turns left out. Order kept. */
export function liveTranscriptRows<T extends TranscriptRow>(rows: readonly T[]): T[] {
  const superseded = new Set(
    rows.flatMap((row) => (stringField(row.metadata, 'supersededBy') ? [row.id] : [])),
  )
  return rows.filter((row) => {
    if (superseded.has(row.id)) return false
    const turnOf = stringField(row.metadata, 'turnOf')
    return !(turnOf && superseded.has(turnOf))
  })
}

export type EditableTurn = {
  /** The user message being replaced. */
  messageId: string
  /** Nothing live comes before it: the replacement re-titles the conversation. */
  isFirst: boolean
}

/**
 * Pure rule over a session's rows (oldest first): only the person's latest,
 * still-live message is editable, and not once an approval card followed it
 * (the decision is the person's own record — a superseded card would leave a
 * pending kernel request nobody sees).
 */
export function editableTurn(rows: readonly TranscriptRow[], messageId: string): EditableTurn {
  const live = liveTranscriptRows(rows)
  const at = live.findIndex((row) => row.id === messageId)
  if (at < 0)
    throw new TurnNotEditableError(
      `message ${messageId} is not a live message of this conversation`,
    )
  if (live[at]!.role !== 'user')
    throw new TurnNotEditableError(`message ${messageId} is not the person's message`)
  for (const row of live.slice(at + 1)) {
    if (row.role === 'user') {
      throw new TurnNotEditableError(
        `message ${messageId} is not the latest message (${row.id} came after it)`,
      )
    }
    if (row.metadata?.variant === 'approval_required') {
      throw new TurnNotEditableError(`message ${messageId} was followed by an approval request`)
    }
  }
  return { messageId, isFirst: at === 0 }
}

type Db = ReturnType<typeof getDb>

/** Load the session's rows and apply editableTurn. */
export async function findEditableTurn(
  db: Db,
  input: { sessionId: string; userId: string; messageId: string },
): Promise<EditableTurn> {
  const rows = await db
    .select({ id: chatMessage.id, role: chatMessage.role, metadata: chatMessage.metadata })
    .from(chatMessage)
    .where(and(eq(chatMessage.sessionId, input.sessionId), eq(chatMessage.userId, input.userId)))
    .orderBy(asc(chatMessage.createdAt))
  return editableTurn(
    rows.map((r) => ({ ...r, metadata: (r.metadata as Record<string, unknown> | null) ?? null })),
    input.messageId,
  )
}

/**
 * Record the replacement: insert the new user message (`replaces` the old
 * one) and mark the old message and every row after it superseded by it —
 * one transaction.
 */
export async function replaceChatTurn(
  db: Db,
  input: {
    sessionId: string
    userId: string
    replacesMessageId: string
    /** The new message's id, chosen up front: the model side was tagged with it already. */
    replacementId: string
    content: string
    metadata: Record<string, unknown> | null
  },
): Promise<void> {
  return db.transaction(async (tx) => {
    const [target] = await tx
      .select({ createdAt: chatMessage.createdAt })
      .from(chatMessage)
      .where(
        and(
          eq(chatMessage.id, input.replacesMessageId),
          eq(chatMessage.sessionId, input.sessionId),
        ),
      )
      .for('update')
    if (!target)
      throw new TurnNotEditableError(`message ${input.replacesMessageId} vanished before the edit`)
    const replacementId = input.replacementId
    await tx.insert(chatMessage).values({
      id: replacementId,
      sessionId: input.sessionId,
      userId: input.userId,
      role: 'user',
      content: input.content,
      metadata: { ...(input.metadata ?? {}), replaces: input.replacesMessageId },
    })
    await tx
      .update(chatMessage)
      .set({
        metadata: sql`coalesce(${chatMessage.metadata}, '{}'::jsonb) || jsonb_build_object('supersededBy', ${replacementId}::text)`,
      })
      .where(
        and(
          eq(chatMessage.sessionId, input.sessionId),
          gte(chatMessage.createdAt, target.createdAt),
          ne(chatMessage.id, replacementId),
          sql`${chatMessage.metadata}->>'supersededBy' is null`,
        ),
      )
  })
}
