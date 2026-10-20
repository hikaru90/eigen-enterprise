import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import type { PersistedChatMessage } from '$lib/chat/normalize-messages'
import type { getDb } from '$lib/server/db'
import { chatMessage, chatSession } from '$lib/server/db/brain.schema'
import { kernelApprovals } from '$lib/server/db/kernel.schema'

export type CurrentConversation = {
  /** The user's current nucleus chat session (null until they first chat). */
  sessionId: string | null
  /** Persisted rows of that session, oldest first (chat_message is the source of truth). */
  messages: PersistedChatMessage[]
}

/**
 * The nucleus chat's current conversation: the user's most recently created
 * 'default'-mode chat_session (the page keeps continuing it, so it stays the
 * newest) plus its stored messages. handleAgentChatPost already writes every
 * user turn, assistant turn and onboarding hand-off reply into chat_message;
 * this is the read side the page load uses.
 */
export async function loadCurrentConversation(
  db: ReturnType<typeof getDb>,
  userId: string,
): Promise<CurrentConversation> {
  const [session] = await db
    .select({ id: chatSession.id })
    .from(chatSession)
    .where(and(eq(chatSession.userId, userId), eq(chatSession.mode, 'default')))
    .orderBy(desc(chatSession.createdAt))
    .limit(1)
  if (!session) return { sessionId: null, messages: [] }

  const rows = await db
    .select({
      role: chatMessage.role,
      content: chatMessage.content,
      metadata: chatMessage.metadata,
    })
    .from(chatMessage)
    .where(and(eq(chatMessage.sessionId, session.id), eq(chatMessage.userId, userId)))
    .orderBy(asc(chatMessage.createdAt))

  return {
    sessionId: session.id,
    messages: rows.map((r) => ({
      role: r.role,
      content: r.content,
      metadata: (r.metadata as Record<string, unknown> | null) ?? null,
    })),
  }
}

/**
 * Current kernel status of the approval requests behind the transcript's
 * approval cards (page load: pending cards keep their Approve / Deny buttons,
 * decided ones show the decision). Ids missing from the result are not
 * decidable from the page.
 */
export async function loadApprovalStatuses(
  db: ReturnType<typeof getDb>,
  approvalIds: string[],
): Promise<Record<string, 'pending' | 'approved' | 'denied'>> {
  if (approvalIds.length === 0) return {}
  const rows = await db
    .select({ id: kernelApprovals.id, status: kernelApprovals.status })
    .from(kernelApprovals)
    .where(inArray(kernelApprovals.id, approvalIds))
  return Object.fromEntries(rows.map((r) => [r.id, r.status]))
}
