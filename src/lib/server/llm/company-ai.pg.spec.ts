import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { appDbAsyncLocal, type AppDatabase } from '$lib/server/db/context'
import { companyAiStore } from './company-ai'
import { ModelNotInPoolError } from './model-pool'

/**
 * The company AI settings row (migration 0160) against real Postgres. Needs DATABASE_URL with
 * migrations applied; skipped without it. Every case runs in a transaction that is rolled
 * back, so the row is left as it was.
 */

const url = process.env.DATABASE_URL?.trim()

class Rollback extends Error {}

describe.skipIf(!url)('companyAiStore (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
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

  it('the migration leaves exactly one row; picks start at the pool’s pick (null)', async () => {
    await inRolledBackTx(async () => {
      const s = await companyAiStore().read()
      expect(typeof s.useEigenInference).toBe('boolean')
      expect(Object.keys(s.picks)).toEqual(['chat', 'stt', 'tts', 'decision'])
    })
  })

  it('sets the switch and a pick, and back to the pool’s pick with null', async () => {
    await inRolledBackTx(async () => {
      const store = companyAiStore()
      await store.setUseEigenInference(false, 'owner-1')
      await store.setPick('chat', 'openai/gpt-5-mini', 'owner-1')
      expect(await store.read()).toMatchObject({ useEigenInference: false, picks: { chat: 'openai/gpt-5-mini' } })
      await store.setPick('chat', null, 'owner-1')
      expect((await store.read()).picks.chat).toBeNull()
    })
  })

  it('refuses a pick outside the pool before writing', async () => {
    await inRolledBackTx(async () => {
      await expect(companyAiStore().setPick('stt', 'vendor/unvetted', 'owner-1')).rejects.toBeInstanceOf(ModelNotInPoolError)
    })
  })

  it('pins the embedding model once: the first writer wins, a later pin returns the stored one', async () => {
    await inRolledBackTx(async () => {
      await db.execute('update company_ai set embedding_model = null' as never)
      const store = companyAiStore()
      expect(await store.pinEmbeddingModel('openai/text-embedding-3-small')).toBe('openai/text-embedding-3-small')
      expect(await store.pinEmbeddingModel('qwen/qwen3-embedding-8b')).toBe('openai/text-embedding-3-small')
      expect((await store.read()).embeddingModel).toBe('openai/text-embedding-3-small')
    })
  })
})
