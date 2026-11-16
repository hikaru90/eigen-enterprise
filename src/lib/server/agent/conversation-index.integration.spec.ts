import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { durableConversations } from '$lib/server/db/durable.schema'

/**
 * A member's own conversation name (Contribute 495e40bb, migration 0143) in
 * real Postgres (test DB, :5433): stored as given, not activity, and a later
 * touch (a new turn) leaves it alone.
 */
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('DbDurableConversationIndex.setUserTitle', () => {
  type AppDatabase = import('$lib/server/db/context').AppDatabase
  let admin: AppDatabase
  const key = `orchestrator:rename-${Date.now().toString(36)}`

  beforeAll(async () => {
    const db = await import('$lib/server/db')
    admin = db.createScopedDrizzle(db.appSql)
  })

  afterAll(async () => {
    if (!admin) return
    await admin.delete(durableConversations).where(eq(durableConversations.conversationKey, key))
  })

  it('stores the name without bumping activity, and a new turn keeps it', async () => {
    const { DbDurableConversationIndex } = await import('./conversation-index')
    const index = new DbDurableConversationIndex(async () => admin)
    const row = await index.recordConversation({
      conversationKey: key,
      agentId: 'orchestrator',
      llmUserId: 'rename-owner',
      piConversationId: `pi-${key}`,
      providerSessionId: `prov-${key}`,
    })
    expect(row.userTitle).toBeNull()

    expect(await index.setUserTitle(row.id, 'Bäckerei-Website')).toBe(true)
    const renamed = await index.resolveByConversationKey(key)
    expect(renamed).toMatchObject({ userTitle: 'Bäckerei-Website', updatedAt: row.updatedAt })

    await index.touch(row.id)
    expect((await index.resolveByConversationKey(key))?.userTitle).toBe('Bäckerei-Website')
  })

  it('reports an unknown row', async () => {
    const { DbDurableConversationIndex } = await import('./conversation-index')
    const index = new DbDurableConversationIndex(async () => admin)
    expect(await index.setUserTitle(2_000_000_000, 'x')).toBe(false)
  })
})
