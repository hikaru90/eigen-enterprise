import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import { dbContributeStore } from '../db-store'
import { dbShareStore } from './db-store'

/**
 * The sharing outbox + settings against real Postgres (the test DB, :5433),
 * with the contribute store's hooks. Needs DATABASE_URL with migrations
 * applied (0136); skipped without it. The settings row is restored after.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('contribute share store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const ids: string[] = []
  let saved: { enabled: boolean; install_id: string | null; registered_at: Date | null; revoked_at: Date | null; last_error: string | null }

  beforeAll(async () => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
    ;[saved] = await sql`select enabled, install_id, registered_at, revoked_at, last_error from contribute_share_settings where id = 1`
  })

  afterAll(async () => {
    if (ids.length > 0) await sql`delete from contributions where id in ${sql(ids)}`
    await sql`update contribute_share_settings set enabled = ${saved.enabled}, install_id = ${saved.install_id}, registered_at = ${saved.registered_at},
      revoked_at = ${saved.revoked_at}, last_error = ${saved.last_error} where id = 1`
    await sql.end()
  })

  const row = () => {
    const id = randomUUID()
    ids.push(id)
    const at = new Date()
    return { id, title: `share-pg ${id}`, kind: 'idea' as const, area: 'drive' as const, status: 'requested' as const, authorId: 'share-pg-ana', note: null, createdAt: at, updatedAt: at, shippedAt: null }
  }

  it('settings: one row; enable, identity, registration, revocation', async () => {
    const share = dbShareStore(db)
    const at = new Date()
    await share.setEnabled(false, at)
    expect((await share.settings()).enabled).toBe(false)
    await share.setEnabled(true, at)
    const install = randomUUID()
    await share.setInstallId(install, at)
    await share.setLastError('hub down', at)
    await share.setRegistered(at, at)
    expect(await share.settings()).toMatchObject({ enabled: true, installId: install, registeredAt: at, lastError: null, revokedAt: null })
    await share.setRevoked(at, 'refused')
    expect(await share.settings()).toMatchObject({ revokedAt: at, lastError: 'refused' })
    await sql`update contribute_share_settings set revoked_at = null, last_error = null where id = 1`
  })

  it('hooks: sharing on → pending row in the insert; off → none; a vote/status change dirties a sent row', async () => {
    const share = dbShareStore(db)
    const store = dbContributeStore(db)
    await share.setEnabled(false, new Date())
    const off = row()
    await store.insert(off)
    expect(await share.entry(off.id)).toBeNull()

    await share.setEnabled(true, new Date())
    const on = row()
    await store.insert(on)
    expect(await share.entry(on.id)).toMatchObject({ state: 'pending', attempts: 0, lastSentHash: null })

    await sql`update contribute_outbox set state = 'sent', last_sent_hash = 'h', next_attempt_at = '2100-01-01' where contribution_id = ${on.id}`
    await store.setVote(on.id, 'share-pg-ben', 1)
    const dirty = await share.entry(on.id)
    expect(dirty?.state).toBe('scrubbed')
    expect(dirty!.nextAttemptAt.getTime()).toBeLessThan(Date.parse('2100-01-01'))

    await sql`update contribute_outbox set state = 'sent' where contribution_id = ${on.id}`
    await store.update(on.id, { status: 'in_progress', updatedAt: new Date() })
    expect((await share.entry(on.id))?.state).toBe('scrubbed')
  })

  it('claim (SKIP LOCKED lease), scrub, send — a change during the send keeps it due; retry, fail, exclude, withdraw', async () => {
    const share = dbShareStore(db)
    const store = dbContributeStore(db)
    await share.setEnabled(true, new Date())
    const a = row()
    const b = row()
    await store.insert(a)
    await store.insert(b)

    const now = new Date(Date.now() + 1000)
    const lease = new Date(now.getTime() + 5 * 60_000)
    expect(await share.hasDue(now)).toBe(true)
    const claimed = await share.claimDue(now, 500, lease)
    const mine = claimed.filter((e) => e.contributionId === a.id || e.contributionId === b.id)
    expect(mine).toHaveLength(2)
    expect(mine[0].updatedAt).toEqual(now)
    expect(mine[0].nextAttemptAt).toEqual(lease)
    // Leased: a second claim does not see them.
    expect((await share.claimDue(now, 500, lease)).some((e) => e.contributionId === a.id)).toBe(false)

    await share.saveScrub(a.id, { summary: 'Drive search', language: 'en' })
    await share.markSent(a.id, 'hash-a', now, now)
    expect(await share.entry(a.id)).toMatchObject({ state: 'sent', lastSentHash: 'hash-a', summary: 'Drive search', language: 'en', lastError: null })

    // b: a vote lands while it is in flight → it stays scrubbed and is due again.
    await share.saveScrub(b.id, { summary: 'Drive tags', language: 'de' })
    await store.setVote(b.id, 'share-pg-ben', 1)
    await share.markSent(b.id, 'hash-b', now, now)
    const b1 = await share.entry(b.id)
    expect(b1).toMatchObject({ state: 'scrubbed', lastSentHash: 'hash-b' })
    expect(b1!.nextAttemptAt).toEqual(now)

    await share.markRetry(b.id, 'hub: HTTP 503', 2, lease, now)
    expect(await share.entry(b.id)).toMatchObject({ state: 'scrubbed', attempts: 2, lastError: 'hub: HTTP 503', nextAttemptAt: lease })
    await share.markFailed(b.id, 'hub refused (HTTP 400)', now)
    expect((await share.entry(b.id))?.state).toBe('failed')

    // "Don't share" on a sent row: excluded, still on the hub → due for its DELETE; then withdrawn.
    await share.exclude(a.id, now)
    expect(await share.entry(a.id)).toMatchObject({ state: 'excluded', lastSentHash: 'hash-a' })
    expect((await share.claimDue(now, 500, lease)).some((e) => e.contributionId === a.id)).toBe(true)
    await share.markWithdrawn(a.id, now)
    expect(await share.entry(a.id)).toMatchObject({ state: 'excluded', lastSentHash: null, sentAt: null })
    expect((await share.claimDue(new Date(lease.getTime() + 1), 500, lease)).some((e) => e.contributionId === a.id)).toBe(false)

    // Exclude a proposal that has no row yet.
    const c = row()
    await share.setEnabled(false, new Date())
    await store.insert(c)
    await share.exclude(c.id, now)
    expect((await share.entry(c.id))?.state).toBe('excluded')

    const entries = await share.entries([a.id, b.id, c.id, randomUUID()])
    expect([...entries.keys()].sort()).toEqual([a.id, b.id, c.id].sort())
    const counts = await share.counts()
    expect(counts.failed).toBeGreaterThanOrEqual(1)
    expect(counts.lastError?.message).toBeTruthy()
  })
})
