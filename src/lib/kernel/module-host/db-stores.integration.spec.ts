import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { helloVersion } from './testing/hello'
import type { ModuleRecord } from './types'

/**
 * The module host's stores on real Postgres (migration 0179): kernel_modules
 * round trip, published versions, the module principal's token hash, the
 * event cursor and the (ts, id)-ordered event feed over kernel_events.
 */
const hasDb = Boolean(process.env.DATABASE_URL)

describe.skipIf(!hasDb)('module host stores on Postgres', () => {
  const id = `t${Date.now().toString(36)}${Math.random().toString(16).slice(2, 6)}`.slice(0, 20)
  type Mods = {
    stores: typeof import('./db-stores')
    db: typeof import('$lib/server/db')
    schema: typeof import('$lib/server/db/kernel.schema')
    orm: typeof import('drizzle-orm')
  }
  let m: Mods
  const handle = () => m.db.companyDb()

  beforeAll(async () => {
    m = {
      stores: await import('./db-stores'),
      db: await import('$lib/server/db'),
      schema: await import('$lib/server/db/kernel.schema'),
      orm: await import('drizzle-orm'),
    }
  })
  afterAll(async () => {
    const { eq, like } = m.orm
    const db = handle()
    await db.delete(m.schema.kernelModules).where(eq(m.schema.kernelModules.id, id))
    await db.delete(m.schema.kernelModuleVersions).where(eq(m.schema.kernelModuleVersions.moduleId, id))
    await db.delete(m.schema.kernelModuleEventCursor).where(eq(m.schema.kernelModuleEventCursor.moduleId, id))
    await db.delete(m.schema.kernelPrincipals).where(eq(m.schema.kernelPrincipals.id, `module:${id}`))
    await db.delete(m.schema.kernelEvents).where(like(m.schema.kernelEvents.type, `${id}.%`))
  })

  it('kernel_modules and kernel_module_versions round-trip a record', async () => {
    const store = new m.stores.DbModuleStore(handle)
    const record: ModuleRecord = {
      id,
      ownerUserId: 'owner-1',
      manifest: null,
      receipt: null,
      commit: null,
      bundleSha256: null,
      state: 'unpublished',
      reason: null,
      stateSince: '2026-11-24T12:00:00.000Z',
      firstDeployedAt: null,
      deployedFrom: null,
      deployedBy: null,
      pendingDeploy: null,
    }
    await store.create(record)
    await expect(store.create(record)).rejects.toThrow()
    expect(await store.get(id)).toEqual(record)
    const { version } = await helloVersion('a'.repeat(40))
    const v = { ...version, moduleId: id }
    await store.addVersion(v)
    expect(await store.version(id, v.commit)).toEqual(v)
    const failed: ModuleRecord = {
      ...record,
      manifest: v.manifest,
      receipt: v.receipt,
      commit: v.commit,
      bundleSha256: v.bundleSha256,
      state: 'failed',
      reason: 'Hello is switched off because it stopped answering. Its data is kept.',
      firstDeployedAt: '2026-11-24T12:01:00.000Z',
      deployedFrom: 'running',
      deployedBy: 'owner-1',
      pendingDeploy: { commit: v.commit, by: 'agent-1', at: '2026-11-24T12:02:00.000Z' },
    }
    await store.put(failed)
    expect(await store.get(id)).toEqual(failed)
    expect((await store.list()).some((r) => r.id === id)).toBe(true)
    await expect(store.put({ ...failed, id: `${id}x` })).rejects.toThrow(/does not exist/)
  })

  it('the module principal: kind service, no roles, the token hash', async () => {
    const principals = new m.stores.DbModulePrincipals(handle)
    expect(await principals.tokenHash(id)).toBeNull()
    await principals.setTokenHash(id, '1'.repeat(64))
    await principals.setTokenHash(id, '2'.repeat(64))
    expect(await principals.tokenHash(id)).toBe('2'.repeat(64))
    const [row] = await handle()
      .select()
      .from(m.schema.kernelPrincipals)
      .where(m.orm.eq(m.schema.kernelPrincipals.id, `module:${id}`))
    expect(row).toMatchObject({ kind: 'service', roles: [] })
  })

  it('the event feed: only the asked types, after the cursor, in (ts, id) order; the cursor round-trips', async () => {
    const sink = new (await import('../db-stores')).DbEventSink(handle)
    const feed = m.stores.dbEventFeed(handle)
    const at = (s: number) => new Date(Date.UTC(2026, 10, 24, 12, 0, s)).toISOString()
    const ids = ['00000000-0000-4000-8000-000000000003', '00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002']
    await sink.emit({ id: ids[0]!, ts: at(1), type: `${id}.a`, payload: { n: 1 } })
    await sink.emit({ id: ids[1]!, ts: at(2), type: `${id}.a`, payload: { n: 2 } })
    await sink.emit({ id: ids[2]!, ts: at(2), type: `${id}.a`, payload: { n: 3 } })
    await sink.emit({ id: '00000000-0000-4000-8000-000000000004', ts: at(3), type: `${id}.other`, payload: {} })
    const start = { startedAt: at(0), lastTs: null, lastId: null }
    expect((await feed.after(start, [`${id}.a`], 10)).map((e) => e.id)).toEqual([ids[0], ids[1], ids[2]])
    expect((await feed.after({ ...start, lastTs: at(2), lastId: ids[1]! }, [`${id}.a`], 10)).map((e) => e.id)).toEqual([ids[2]])
    expect(await feed.after({ ...start, startedAt: at(5) }, [`${id}.a`], 10)).toEqual([])

    const cursors = new m.stores.DbCursorStore(handle)
    const cursor = {
      moduleId: id,
      startedAt: at(0),
      lastTs: at(2),
      lastId: ids[1]!,
      attempts: 2,
      failingSince: at(4),
      nextAttemptAt: at(9),
    }
    await cursors.put(cursor)
    expect(await cursors.get(id)).toEqual(cursor)
    await cursors.remove(id)
    expect(await cursors.get(id)).toBeNull()
  })

  it('the sharing OK: the first one stands', async () => {
    const sharing = new m.stores.DbSharingStore(handle)
    const before = await sharing.get()
    const first = await sharing.accept('owner-1')
    expect((await sharing.accept('someone-else')).by).toBe(first.by)
    if (before === null) {
      await handle().delete(m.schema.kernelModuleSharing)
    }
  })
})
