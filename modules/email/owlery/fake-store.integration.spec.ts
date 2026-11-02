import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { DbFakeMailStore } from './fake-store'

const hasDb = Boolean(process.env.DATABASE_URL)

/** The captured mails survive a new store instance (a restart / a second request). */
describe.skipIf(!hasDb)('DbFakeMailStore (test database)', () => {
  let db: AppDatabase
  const to = `fake-${Date.now().toString(36)}@kindred.test`

  beforeAll(async () => {
    const { createScopedDrizzle, appSql } = await import('$lib/server/db')
    db = createScopedDrizzle(appSql)
  })

  afterAll(async () => {
    await new DbFakeMailStore(db).clear()
  })

  it('persists identities and captured mails across store instances', async () => {
    const first = new DbFakeMailStore(db)
    await first.createIdentity(`Sender-${to}`)
    const captured = await first.capture({ from: 'hello@kindred.test', to, subject: 'Persisted', html: '<p>x</p>', text: 'x' })
    expect(captured.messageId).toMatch(/^fake-/)

    const second = new DbFakeMailStore(async () => db)
    expect(await second.getIdentity(`sender-${to}`)).toEqual({ exists: true, verified: false })
    await second.verifyIdentity(`sender-${to}`)
    expect(await first.getIdentity(`sender-${to}`)).toEqual({ exists: true, verified: true })
    expect(await second.list({ to: to.toUpperCase() })).toEqual([
      expect.objectContaining({ to, subject: 'Persisted', messageId: captured.messageId }),
    ])
  })

  it('clear forgets every mail and identity', async () => {
    const store = new DbFakeMailStore(db)
    await store.capture({ from: 'hello@kindred.test', to, subject: 'Gone', html: '<p>x</p>', text: 'x' })
    await store.clear()
    expect(await store.list({ to })).toEqual([])
    expect(await store.getIdentity(`sender-${to}`)).toEqual({ exists: false, verified: false })
  })
})
