import { randomUUID } from 'node:crypto'
import { drizzle } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { LogEntry, Peer } from '$lib/office/xlsx/collab/protocol'
import type { AppDatabase } from '$lib/server/db/context'
import { makeDbSheetLiveStore, SHEET_LIVE_NOTIFY_CHANNEL } from './db-store'

/**
 * Postgres persistence & advisory lock tests for sheet-live (migration 0186).
 * Needs DATABASE_URL with migrations applied; skipped without it.
 */

const url = process.env.DATABASE_URL?.trim()

describe.skipIf(!url)('dbSheetLiveStore (Postgres)', () => {
  let sqlA: postgres.Sql
  let sqlB: postgres.Sql
  const fileIds: string[] = []

  const newFileId = () => {
    const id = `sheet-pg-${randomUUID()}`
    fileIds.push(id)
    return id
  }

  const makeEntry = (seq: number, opId: string, at: string, clientId = 'c1'): LogEntry => ({
    seq,
    clientId,
    opId,
    author: { kind: 'user', id: 'pg-user', name: 'PG User' },
    body: {
      kind: 'change',
      ops: [{ op: 'set_cells', sheet: 'Sheet1', cells: [{ ref: 'A1', value: seq }] }],
      acceptLosses: false,
    },
    at,
  })

  beforeAll(() => {
    sqlA = postgres(url!, { prepare: false, max: 3, onnotice: () => {} })
    sqlB = postgres(url!, { prepare: false, max: 3, onnotice: () => {} })
  })

  afterAll(async () => {
    if (fileIds.length > 0) {
      await sqlA`delete from sheet_live_entry where file_id in ${sqlA(fileIds)}`
      await sqlA`delete from sheet_live_peer where file_id in ${sqlA(fileIds)}`
      await sqlA`delete from sheet_live_session where file_id in ${sqlA(fileIds)}`
    }
    await sqlA.end()
    await sqlB.end()
  })

  it('persists sessions, chunked entries, queries unsaved sessions, and prunes old entries', async () => {
    const store = makeDbSheetLiveStore(() => drizzle(sqlA) as unknown as AppDatabase)
    const fileId = newFileId()
    const oldAt = new Date('2026-11-25T08:00:00.000Z')
    const newAt = new Date('2026-11-25T10:00:00.000Z')

    await store.locked(fileId, async (tx) => {
      await tx.putSession({
        fileId,
        baseSha256: 'a'.repeat(64),
        baseSeq: 0,
        headSeq: 650,
        epochSeq: 0,
        updatedAt: oldAt,
        savedAt: null,
      })
      const batch: LogEntry[] = []
      for (let i = 1; i <= 650; i++) {
        batch.push(makeEntry(i, `op-${i}`, (i <= 300 ? oldAt : newAt).toISOString()))
      }
      await tx.append(batch)
    })

    const sess = await store.session(fileId)
    expect(sess).toMatchObject({ fileId, baseSeq: 0, headSeq: 650, epochSeq: 0, savedAt: null })
    expect(await store.unsaved(new Date('2026-11-25T09:00:00.000Z'))).toContain(fileId)
    expect(await store.unsaved(new Date('2026-11-25T07:00:00.000Z'))).not.toContain(fileId)

    const slice = await store.entriesAfter(fileId, 647, 10)
    expect(slice.map((e) => e.seq)).toEqual([648, 649, 650])
    expect(slice[0]!.body).toMatchObject({ kind: 'change', ops: [{ op: 'set_cells', cells: [{ ref: 'A1', value: 648 }] }] })

    await store.locked(fileId, async (tx) => {
      expect(await tx.findEntry('c1', 'op-42')).toMatchObject({ seq: 42, opId: 'op-42' })
      expect(await tx.findEntry('c1', 'missing')).toBeNull()
      await tx.prune(400, new Date('2026-11-25T09:00:00.000Z'))
    })
    // Entries 1..300 match seq <= 400 and at < cutoff -> pruned; 301..650 stay.
    expect((await store.entriesAfter(fileId, 0, Number.MAX_SAFE_INTEGER)).map((e) => e.seq)[0]).toBe(301)
  })

  it('serializes concurrent transactions per fileId with pg_advisory_xact_lock', async () => {
    const storeA = makeDbSheetLiveStore(() => drizzle(sqlA) as unknown as AppDatabase)
    const storeB = makeDbSheetLiveStore(() => drizzle(sqlB) as unknown as AppDatabase)
    const fileId = newFileId()

    await storeA.locked(fileId, async (tx) => {
      await tx.putSession({
        fileId,
        baseSha256: 'b'.repeat(64),
        baseSeq: 0,
        headSeq: 0,
        epochSeq: 0,
        updatedAt: new Date(),
        savedAt: null,
      })
    })

    // Run 8 concurrent increments from two separate Postgres connections; without advisory locking they'd collide on PK or lose updates.
    await Promise.all(
      Array.from({ length: 8 }, (_, idx) => {
        const s = idx % 2 === 0 ? storeA : storeB
        return s.locked(fileId, async (tx) => {
          const cur = (await tx.session())!
          await new Promise((r) => setTimeout(r, 15))
          const nextSeq = cur.headSeq + 1
          await tx.append([makeEntry(nextSeq, `concurrent-${idx}`, new Date().toISOString(), `c-${idx}`)])
          await tx.putSession({ ...cur, headSeq: nextSeq, updatedAt: new Date() })
        })
      }),
    )

    expect((await storeA.session(fileId))?.headSeq).toBe(8)
    expect((await storeA.entriesAfter(fileId, 0, 50)).map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('stores, updates, queries, removes, and prunes cross-process peers', async () => {
    const store = makeDbSheetLiveStore(() => drizzle(sqlA) as unknown as AppDatabase)
    const fileId = newFileId()
    const staleAt = new Date('2026-11-25T09:00:00.000Z')
    const freshAt = new Date('2026-11-25T10:00:00.000Z')

    const alicePeer: Peer = { clientId: 'tab-a', userId: 'alice', name: 'Alice', color: 0, sheet: 'Sheet1', range: 'A1', editing: true }
    const stalePeer: Peer = { clientId: 'tab-b', userId: 'bob', name: 'Bob', color: 2, sheet: null, range: null, editing: false }

    await store.putPeer(fileId, alicePeer, freshAt)
    await store.putPeer(fileId, { ...alicePeer, range: 'B2:D4' }, freshAt)
    await store.putPeer(fileId, stalePeer, staleAt)

    expect(await store.findPeer(fileId, 'tab-a')).toMatchObject({ range: 'B2:D4' })
    expect((await store.livePeers(fileId, new Date('2026-11-25T09:30:00.000Z'))).map((p) => p.clientId)).toEqual(['tab-a'])

    await store.prunePeers(new Date('2026-11-25T09:30:00.000Z'))
    expect(await store.findPeer(fileId, 'tab-b')).toBeNull()

    await store.removePeer(fileId, 'tab-a')
    expect(await store.findPeer(fileId, 'tab-a')).toBeNull()
  })

  it('delivers pg_notify payloads across connections on ee_sheet_live', async () => {
    const fileId = newFileId()
    const got: string[] = []
    const listener = await sqlB.listen(SHEET_LIVE_NOTIFY_CHANNEL, (payload) => got.push(payload))
    try {
      const msg = JSON.stringify({ k: 'entries', f: fileId, seq: 3 })
      await sqlA`SELECT pg_notify(${SHEET_LIVE_NOTIFY_CHANNEL}, ${msg})`
      await new Promise((r) => setTimeout(r, 100))
      expect(got).toContain(msg)
    } finally {
      await listener.unlisten()
    }
  })
})
