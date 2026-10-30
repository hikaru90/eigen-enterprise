import { and, eq, sql } from 'drizzle-orm'
import { sanitizeFinalAnswerText } from '$lib/chat/chat-stream-types'
import { sessionIdOfConversationKey } from '$lib/kernel/engines/durable'
import type { ResumedChatTurn } from '$lib/server/agent/durable-harness'
import { withDbUser } from '$lib/server/db'
import { chatMessage, chatSession } from '$lib/server/db/brain.schema'

/**
 * D9 (plan/phase-durable.md): the chat endpoint writes chat_message rows around
 * a live dispatch. When the server died mid-turn, pi-durable still finishes the
 * turn after the restart — but the request that would have written its bubble
 * is gone. The harness hands such a resumed, settled chat turn here, and its
 * reply is written into the chat session under the chat user's RLS session.
 *
 * Idempotent: keyed on the durable answer (`chat_message.durable_answer_key`,
 * unique), so a re-delivered turn never writes a second bubble.
 *
 * `not_a_chat`: the conversation's session is not a chat session of that user
 * (e.g. a Telegram gateway session) — there is no chat bubble to mirror.
 */
export async function mirrorResumedChatTurn(
  turn: ResumedChatTurn,
): Promise<'mirrored' | 'duplicate' | 'not_a_chat'> {
  const sessionId = sessionIdOfConversationKey(turn.agentId, turn.conversationKey)
  return withDbUser(turn.llmUserId, async (db) => {
    const [session] = await db
      .select({ id: chatSession.id })
      .from(chatSession)
      .where(
        and(sql`${chatSession.id}::text = ${sessionId}`, eq(chatSession.userId, turn.llmUserId)),
      )
      .limit(1)
    if (!session) return 'not_a_chat'
    const content = sanitizeFinalAnswerText(
      turn.reply.trim().length > 0 ? turn.reply : 'The assistant did not produce a response.',
    )
    const inserted = await db
      .insert(chatMessage)
      .values({
        sessionId: session.id,
        userId: turn.llmUserId,
        role: 'assistant',
        content,
        durableAnswerKey: turn.answerKey,
      })
      .onConflictDoNothing({ target: chatMessage.durableAnswerKey })
      .returning({ id: chatMessage.id })
    return inserted.length > 0 ? 'mirrored' : 'duplicate'
  })
}
