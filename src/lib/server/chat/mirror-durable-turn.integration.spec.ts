import { eq, inArray } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { user } from '$lib/server/db/auth.schema'
import { chatMessage, chatSession } from '$lib/server/db/brain.schema'
import { durableConversations } from '$lib/server/db/durable.schema'

/**
 * D9 (plan/phase-durable.md): a chat turn that settled after a restart (no
 * live request) is mirrored into chat_message — under the chat user's RLS
 * session, exactly once per durable answer. Real Postgres (test DB, :5433).
 */
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)(
  'mirrorResumedChatTurn (chat_message mirror of resumed durable turns)',
  () => {
    type AppDatabase = import('$lib/server/db/context').AppDatabase
    let admin: AppDatabase
    let mirror: typeof import('./mirror-durable-turn').mirrorResumedChatTurn
    const suffix = Date.now().toString(36)
    const userId = `mirror_user_${suffix}`
    let sessionId: string

    beforeAll(async () => {
      const db = await import('$lib/server/db')
      admin = db.createScopedDrizzle(db.appSql)
      mirror = (await import('./mirror-durable-turn')).mirrorResumedChatTurn
      await admin
        .insert(user)
        .values({ id: userId, name: 'Mirror', email: `${userId}@example.test` })
      const [session] = await admin
        .insert(chatSession)
        .values({ userId, mode: 'default', title: '' })
        .returning({ id: chatSession.id })
      sessionId = session!.id
    })

    afterAll(async () => {
      if (!admin) return
      await admin
        .delete(user)
        .where(eq(user.id, userId))
        .catch(() => undefined)
      await admin
        .delete(durableConversations)
        .where(inArray(durableConversations.conversationKey, [`factory:${suffix}`]))
        .catch(() => undefined)
    })

    const turn = () => ({
      conversationKey: `orchestrator:${sessionId}`,
      agentId: 'orchestrator',
      llmUserId: userId,
      piConversationId: '42',
      answerKey: `42:${suffix}`,
      reply: 'the reply that finished after the restart',
    })

    it('writes the assistant bubble into the chat session, once per durable answer', async () => {
      expect(await mirror(turn())).toBe('mirrored')
      expect(await mirror(turn())).toBe('duplicate')
      const rows = await admin
        .select()
        .from(chatMessage)
        .where(eq(chatMessage.sessionId, sessionId))
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        role: 'assistant',
        userId,
        content: 'the reply that finished after the restart',
        durableAnswerKey: `42:${suffix}`,
      })
    })

    it('a session id that is not a chat session of that user is not mirrored', async () => {
      expect(
        await mirror({
          ...turn(),
          conversationKey: 'orchestrator:telegram-123',
          answerKey: `x:${suffix}`,
        }),
      ).toBe('not_a_chat')
    })

    it('the conversation index stores the run principal and tool surface of a background run', async () => {
      const { DbDurableConversationIndex } = await import('$lib/server/agent/conversation-index')
      const index = new DbDurableConversationIndex(async () => admin)
      const tools = [
        { name: 'repo.read_file', description: 'read', parametersJsonSchema: { type: 'object' } },
      ]
      const row = await index.recordConversation({
        conversationKey: `factory:${suffix}`,
        agentId: 'factory',
        llmUserId: userId,
        piConversationId: `pi-${suffix}`,
        providerSessionId: `prov-${suffix}`,
        runPrincipalId: 'agent:factory',
        runTools: tools,
      })
      expect(row).toMatchObject({ runPrincipalId: 'agent:factory', runTools: tools })
      expect(await index.resolveByPiConversationId(`pi-${suffix}`)).toMatchObject({
        conversationKey: `factory:${suffix}`,
      })
    })
  },
)
