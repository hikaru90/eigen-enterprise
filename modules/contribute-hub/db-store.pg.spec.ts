import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { AppDatabase } from '$lib/server/db/context'
import type { HubContributionInput } from './store'
import { dbHubStore } from './db-store'

/**
 * The hub store against real Postgres (the test DB, :5433). Needs
 * DATABASE_URL with migrations applied (0137); skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('contribute hub store (Postgres)', () => {
  let sql: postgres.Sql
  let db: AppDatabase
  const installs: string[] = []
  const hashes: string[] = []

  beforeAll(() => {
    sql = postgres(url!, { prepare: false, max: 2, onnotice: () => {} })
    db = drizzle(sql) as unknown as AppDatabase
  })

  afterAll(async () => {
    if (installs.length > 0) {
      await sql`delete from hub_installs where install_id in ${sql(installs)}`
      await sql`delete from hub_request_counts where install_id in ${sql(installs)}`
    }
    if (hashes.length > 0) await sql`delete from hub_seen_signatures where signature_hash in ${sql(hashes)}`
    await sql.end()
  })

  const at = (s: number) => new Date(Date.parse('2026-11-13T10:00:00Z') + s * 1000)

  async function install() {
    const store = dbHubStore(db)
    const installId = randomUUID()
    installs.push(installId)
    expect(await store.insertInstall({ installId, publicKey: 'pk-a', appVersion: '0.6.0', at: at(0) })).toBe(true)
    return { store, installId }
  }

  const row = (installId: string, over: Partial<HubContributionInput> = {}): HubContributionInput => ({
    installId,
    remoteId: randomUUID(),
    summary: 'Add a dark mode',
    language: 'en',
    kind: 'idea',
    area: 'everywhere',
    status: 'requested',
    score: 1,
    appVersion: '0.6.0',
    createdDay: '2026-11-12',
    shippedDay: null,
    ...over,
  })

  it('installs: insert once, touch, revoke once, delete with every proposal', async () => {
    const { store, installId } = await install()
    expect(await store.insertInstall({ installId, publicKey: 'pk-b', appVersion: '0.6.0', at: at(1) })).toBe(false)
    expect(await store.getInstall(installId)).toMatchObject({ publicKey: 'pk-a', registeredAt: at(0), revokedAt: null })
    await store.touchInstall(installId, at(5), '0.6.1')
    expect(await store.getInstall(installId)).toMatchObject({ lastSeenAt: at(5), appVersion: '0.6.1' })
    await store.touchInstall(installId, at(6))
    expect((await store.getInstall(installId))?.appVersion).toBe('0.6.1')

    expect((await store.revokeInstall(installId, at(10)))?.revokedAt).toEqual(at(10))
    expect((await store.revokeInstall(installId, at(20)))?.revokedAt).toEqual(at(10))
    expect(await store.revokeInstall(randomUUID(), at(20))).toBeNull()

    const r = row(installId)
    await store.upsert(r, at(30))
    expect(await store.deleteInstall(installId)).toBe(true)
    expect(await store.getInstall(installId)).toBeNull()
    expect(await store.get(installId, r.remoteId)).toBeNull()
    expect(await store.deleteInstall(installId)).toBe(false)
  })

  it('upsert: created, unchanged (nothing written), updated (received_at kept); delete one; list order', async () => {
    const { store, installId } = await install()
    const r = row(installId)
    expect(await store.upsert(r, at(1))).toBe('created')
    expect(await store.upsert(r, at(2))).toBe('unchanged')
    expect((await store.get(installId, r.remoteId))?.updatedAt).toEqual(at(1))
    expect(await store.upsert({ ...r, score: 4, status: 'shipped', shippedDay: '2026-11-13' }, at(3))).toBe('updated')
    expect(await store.get(installId, r.remoteId)).toMatchObject({
      score: 4,
      status: 'shipped',
      shippedDay: '2026-11-13',
      createdDay: '2026-11-12',
      updatedAt: at(3),
      receivedAt: at(1),
    })

    const low = row(installId, { score: 0 })
    const high = row(installId, { score: 9, kind: 'bug', area: 'drive' })
    await store.upsert(low, at(4))
    await store.upsert(high, at(5))
    const mine = (await store.list(['requested'])).filter((x) => x.installId === installId)
    expect(mine.map((x) => x.remoteId)).toEqual([high.remoteId, low.remoteId])
    expect((await store.list(['shipped'])).some((x) => x.remoteId === r.remoteId)).toBe(true)

    expect(await store.deleteContribution(installId, low.remoteId)).toBe(true)
    expect(await store.deleteContribution(installId, low.remoteId)).toBe(false)
    // the check constraints hold
    await expect(store.upsert(row(installId, { summary: '' }), at(6))).rejects.toThrow()
  })

  it('replay guard: a hash is claimed once; old hashes are pruned', async () => {
    const store = dbHubStore(db)
    const h1 = `pg-spec-${randomUUID()}`
    const h2 = `pg-spec-${randomUUID()}`
    hashes.push(h1, h2)
    expect(await store.claimSignature(h1, at(0), at(-300))).toBe(true)
    expect(await store.claimSignature(h1, at(1), at(-299))).toBe(false)
    // h1 seen at 0 falls before the window's start at 10: pruned, then h2 is claimed
    expect(await store.claimSignature(h2, at(400), at(10))).toBe(true)
    const left = await sql`select signature_hash from hub_seen_signatures where signature_hash in ${sql([h1, h2])}`
    expect(left.map((r) => r.signature_hash)).toEqual([h2])
  })

  it('rate limit: counts per install per hour bucket, drops older buckets', async () => {
    const { store, installId } = await install()
    const other = randomUUID()
    installs.push(other)
    const h0 = new Date('2026-11-13T10:00:00Z')
    const h1 = new Date('2026-11-13T11:00:00Z')
    expect(await store.countRequest(installId, h0)).toBe(1)
    expect(await store.countRequest(installId, h0)).toBe(2)
    expect(await store.countRequest(other, h0)).toBe(1)
    expect(await store.countRequest(installId, h1)).toBe(1)
    const old = await sql`select 1 from hub_request_counts where install_id in ${sql([installId, other])} and hour = ${h0.toISOString()}`
    expect(old).toHaveLength(0)
  })
})
