import { asc, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { user } from '$lib/server/db/auth.schema'
import { chatMessage, chatSession } from '$lib/server/db/brain.schema'

/**
 * Edit-and-resend on real Postgres (test DB, :5433): the replacement is
 * recorded in one transaction, the replaced turn stays in chat_message as
 * history, and the chat's read side (loadCurrentConversation) shows the
 * conversation as the model now sees it.
 */
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('replaceChatTurn / findEditableTurn (chat_message)', () => {
  type AppDatabase = import('$lib/server/db/context').AppDatabase
  let admin: AppDatabase
  let edit: typeof import('./turn-edit')
  let current: typeof import('./current-conversation')
  const suffix = Date.now().toString(36)
  const userId = `turn_edit_user_${suffix}`
  let sessionId: string

  async function add(
    role: 'user' | 'assistant',
    content: string,
    metadata: Record<string, unknown> | null = null,
  ) {
    const [row] = await admin
      .insert(chatMessage)
      .values({ sessionId, userId, role, content, ...(metadata ? { metadata } : {}) })
      .returning({ id: chatMessage.id })
    return row!.id
  }

  beforeAll(async () => {
    const db = await import('$lib/server/db')
    admin = db.createScopedDrizzle(db.appSql)
    edit = await import('./turn-edit')
    current = await import('./current-conversation')
    await admin.insert(user).values({ id: userId, name: 'Editor', email: `${userId}@example.test` })
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
  })

  it('supersedes the latest turn (kept as history), shows the edited one, and refuses the old one afterwards', async () => {
    const db = admin as never
    const u1 = await add('user', 'first question')
    await add('assistant', 'first answer', { turnOf: u1 })
    const u2 = await add('user', 'second question', {
      attachments: [{ name: 'a.txt', kind: 'text', sizeBytes: 3 }],
    })
    await add('assistant', 'b', { variant: 'tool_preview', tool: 'memory.search', turnOf: u2 })

    expect(await edit.findEditableTurn(db, { sessionId, userId, messageId: u2 })).toEqual({
      messageId: u2,
      isFirst: false,
    })
    await expect(
      edit.findEditableTurn(db, { sessionId, userId, messageId: u1 }),
    ).rejects.toBeInstanceOf(edit.TurnNotEditableError)

    const u3 = crypto.randomUUID()
    await edit.replaceChatTurn(db, {
      sessionId,
      userId,
      replacesMessageId: u2,
      replacementId: u3,
      content: 'second question, better',
      metadata: null,
    })
    // The stopped run finished anyway and its reply landed after the edit.
    await add('assistant', 'late answer to the old question', { turnOf: u2 })
    await add('assistant', 'answer to the edit', { turnOf: u3 })

    const shown = await current.loadCurrentConversation(db, userId)
    expect(shown.messages.map((m) => m.content)).toEqual([
      'first question',
      'first answer',
      'second question, better',
      'answer to the edit',
    ])
    expect(shown.messages[2]).toMatchObject({ id: u3, role: 'user' })

    // History keeps the superseded rows, marked.
    const all = await admin
      .select({ id: chatMessage.id, metadata: chatMessage.metadata })
      .from(chatMessage)
      .where(eq(chatMessage.sessionId, sessionId))
      .orderBy(asc(chatMessage.createdAt))
    expect(all).toHaveLength(7)
    expect(all.find((r) => r.id === u2)?.metadata).toMatchObject({ supersededBy: u3 })
    expect(all.find((r) => r.id === u3)?.metadata).toEqual({ replaces: u2 })

    await expect(
      edit.findEditableTurn(db, { sessionId, userId, messageId: u2 }),
    ).rejects.toBeInstanceOf(edit.TurnNotEditableError)
    expect(await edit.findEditableTurn(db, { sessionId, userId, messageId: u3 })).toMatchObject({
      messageId: u3,
    })
  })
})
