import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { closeAppDbPool, getDb } from '$lib/server/db'
import { appDbAsyncLocal, type AppDatabase } from '$lib/server/db/context'
import { messageConversations, messages } from '$lib/server/db/messages.schema'
import { messageActivityEvents } from './message-activity'

/**
 * What's happening counts only messages in channels every member can see: DMs, group DMs and
 * private channels never count, for anyone. Needs DATABASE_URL with migrations applied; each
 * case runs in a rolled-back transaction.
 */

const url = process.env.DATABASE_URL?.trim()

class Rollback extends Error {}

describe.skipIf(!url)('messageActivityEvents (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    await closeAppDbPool()
    await sql.end()
  })

  async function inRolledBackTx(fn: () => Promise<void>): Promise<void> {
    await expect(
      db.transaction(async (tx) => {
        await appDbAsyncLocal.run(tx as unknown as AppDatabase, fn)
        throw new Rollback()
      }),
    ).rejects.toBeInstanceOf(Rollback)
  }

  it('reads outside any request (the job-queue tick builds the digest)', async () => {
    expect(appDbAsyncLocal.getStore()).toBeUndefined()
    await expect(messageActivityEvents(new Date())).resolves.toEqual([])
  })

  it('a DM-only author gets no message count; a public-channel message counts', async () => {
    await inRolledBackTx(async () => {
      const since = new Date(Date.now() - 60_000)
      const at = new Date()
      const [pub, priv, dm, group] = await getDb()
        .insert(messageConversations)
        .values([
          { kind: 'channel', name: 'pa-public', createdBy: 'pa-anna' },
          { kind: 'channel', name: 'pa-private', private: true, createdBy: 'pa-anna' },
          { kind: 'dm', private: true, dmKey: 'pa-anna,pa-dmonly', createdBy: 'pa-dmonly' },
          { kind: 'dm', private: true, dmKey: 'pa-anna,pa-ben,pa-dmonly', createdBy: 'pa-dmonly' },
        ])
        .returning()
      await getDb()
        .insert(messages)
        .values([
          { conversationId: pub.id, authorId: 'pa-anna', body: 'hi all', createdAt: at },
          { conversationId: pub.id, authorId: 'pa-anna', body: 'gone', createdAt: at, deletedAt: at },
          { conversationId: priv.id, authorId: 'pa-anna', body: 'secret', createdAt: at },
          { conversationId: dm.id, authorId: 'pa-dmonly', body: 'psst', createdAt: at },
          { conversationId: group.id, authorId: 'pa-dmonly', body: 'psst all', createdAt: at },
        ])
      const events = (await messageActivityEvents(since)).filter((e) => e.principalId.startsWith('pa-'))
      expect(events).toEqual([{ principalId: 'pa-anna', tool: 'messages.post', at }])
    })
  })
})
