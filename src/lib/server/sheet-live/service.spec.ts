import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { StreamEvent } from '$lib/office/xlsx/collab/protocol'
import { applyBody, seedOf, toWire } from '$lib/office/xlsx/collab/replica'
import { cellKey } from '$lib/office/xlsx/ref'
import { budgetBook } from '$lib/office/xlsx/test-utils/build-xlsx'
import { openWorkbook } from '$lib/office/xlsx/workbook'
import { memoryEditLockStore } from '../../../modules/drive/locks'
import { memoryDriveAccess } from '../../../modules/drive/memory-access'
import { createDriveService, type Actor } from '../../../modules/drive/service'
import { diskBlobStore } from '../../../modules/drive/storage'
import { memoryDriveStore } from '../../../modules/drive/store'
import { createSheetLive, liveLockSession, PRESENCE_TTL_MS, type LiveMessage, type LiveTimers } from './service'
import { memorySheetLiveStore } from './store'

const dirs: string[] = []
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
const alice: Actor = { kind: 'user', userId: 'alice' }
const bob: Actor = { kind: 'user', userId: 'bob' }
const carol: Actor = { kind: 'user', userId: 'carol' }
const dave: Actor = { kind: 'user', userId: 'dave' }

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'sheet-live-spec-'))
  dirs.push(dir)
  let clock = new Date('2026-11-25T10:00:00.000Z').getTime()
  const now = () => new Date(clock)
  const advance = (ms: number) => {
    clock += ms
  }

  const afters: Array<{ fn: () => void; at: number; cancelled: boolean }> = []
  const intervals: Array<{ fn: () => void; cancelled: boolean }> = []
  const timers: LiveTimers = {
    after(fn, ms) {
      const h = { fn, at: clock + ms, cancelled: false }
      afters.push(h)
      return h
    },
    every(fn) {
      const h = { fn, cancelled: false }
      intervals.push(h)
      return h
    },
    clear(h) {
      if (h && typeof h === 'object') (h as { cancelled: boolean }).cancelled = true
    },
  }
  const fireDue = async () => {
    for (const h of afters.splice(0)) {
      if (!h.cancelled && h.at <= clock) h.fn()
      else if (!h.cancelled) afters.push(h)
    }
    await new Promise((r) => setTimeout(r, 10))
  }

  const access = memoryDriveAccess({
    users: {
      alice: { role: 'member' },
      bob: { role: 'member' },
      carol: { role: 'member' },
      dave: { role: 'member' },
    },
  })
  const drive = createDriveService({
    store: memoryDriveStore(),
    blobs: diskBlobStore(dir),
    access,
    maxUploadBytes: 1 << 22,
    locks: memoryEditLockStore(),
  })
  const store = memorySheetLiveStore()
  const published: LiveMessage[] = []
  const live: ReturnType<typeof createSheetLive> = createSheetLive({
    drive,
    store,
    publish: async (m) => {
      published.push(m)
      live.receive(m)
    },
    nameOf: async (a) => (a.kind === 'user' ? a.userId : a.id),
    now,
    idleMs: 2_000,
    timers,
  })

  const folder = await drive.createFolder(alice, null, 'Shared')
  access.grants.push(
    { resourceType: 'folder', resourceId: folder.id, subject: { kind: 'user', userId: 'bob' }, level: 'edit' },
    { resourceType: 'folder', resourceId: folder.id, subject: { kind: 'user', userId: 'carol' }, level: 'view' },
    { resourceType: 'folder', resourceId: folder.id, subject: { kind: 'user', userId: 'dave' }, level: 'edit' },
  )
  const file = await drive.upload(alice, folder.id, { name: 'budget.xlsx', bytes: budgetBook(), mime: XLSX }, 'fail')

  return { dir, drive, store, live, fileId: file.id, advance, fireDue, published }
}

const flushMicro = () => new Promise((r) => setTimeout(r, 15))

describe('createSheetLive service', () => {
  it('rebases concurrent submits, supports idempotent resend, and handles undo/redo safely', async () => {
    const { live, fileId, drive } = await setup()
    const j = await live.join(alice, fileId)
    expect(j).toMatchObject({ baseSeq: 0, head: 0, entries: [], canEdit: true })

    // Alice inserts row 0; concurrently Bob (from baseSeq 0) writes A1 -> shifts to A2.
    const rAlice = await live.submit(alice, fileId, {
      clientId: 'tab-a',
      baseSeq: 0,
      changes: [{ opId: 'a1', body: { kind: 'change', ops: [{ op: 'insert_rows', sheet: 'Budget', at: 0, count: 1 }], acceptLosses: false } }],
    })
    expect(rAlice).toMatchObject({ state: 'ok', accepted: [{ opId: 'a1', seq: 1 }], rejected: [], head: 1 })

    const rBob = await live.submit(bob, fileId, {
      clientId: 'tab-b',
      baseSeq: 0,
      changes: [
        {
          opId: 'b1',
          body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'A1', value: 'shifted' }] }], acceptLosses: false },
        },
      ],
    })
    expect(rBob).toMatchObject({ state: 'ok', accepted: [{ opId: 'b1', seq: 2 }], rejected: [], head: 2 })

    // Resending the same opId is idempotent.
    const resend = await live.submit(bob, fileId, {
      clientId: 'tab-b',
      baseSeq: 0,
      changes: [
        {
          opId: 'b1',
          body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'A1', value: 'shifted' }] }], acceptLosses: false },
        },
      ],
    })
    expect(resend).toMatchObject({ state: 'ok', accepted: [{ opId: 'b1', seq: 2 }], rejected: [], head: 2 })

    // Verify workbook content at A2 and late-joiner entry replay.
    const late = await live.join(dave, fileId)
    expect(late.head).toBe(2)
    expect(late.entries).toHaveLength(2)
    expect(late.entries[1]!.body).toMatchObject({ kind: 'change', ops: [{ op: 'set_cells', cells: [{ ref: 'A2', value: 'shifted' }] }] })

    // Alice tries to revert her row insertion after Bob wrote seq 2 -> refused because someone else edited since.
    const badUndo = await live.submit(alice, fileId, {
      clientId: 'tab-a',
      baseSeq: 2,
      changes: [{ opId: 'a2', body: { kind: 'revert', of: 'a1', images: {} } }],
    })
    expect(badUndo.state).toBe('ok')
    if (badUndo.state === 'ok') expect(badUndo.rejected[0]!.error).toMatch(/undo is no longer possible/i)

    // Bob CAN revert his own last op when nobody edited after him.
    const replica = openWorkbook((await drive.readFile(alice, fileId)).bytes)
    applyBody(replica, late.entries[0]!.body, seedOf(late.entries[0]!.clientId, late.entries[0]!.opId))
    const bobApplied = applyBody(replica, late.entries[1]!.body, seedOf(late.entries[1]!.clientId, late.entries[1]!.opId))
    const okUndo = await live.submit(bob, fileId, {
      clientId: 'tab-b',
      baseSeq: 2,
      changes: [{ opId: 'b2', body: { kind: 'revert', of: 'b1', images: toWire(bobApplied.step.before) } }],
    })
    expect(okUndo).toMatchObject({ state: 'ok', accepted: [{ opId: 'b2', seq: 3 }], rejected: [] })
    await live.save(fileId)
    const wb = openWorkbook((await drive.readFile(alice, fileId)).bytes)
    expect(wb.sheet('Budget').cells.get(cellKey(1, 0))?.value).toBe('Item')
  })

  it('enforces viewer read-only permissions while pushing live updates to viewers and late joiners', async () => {
    const { live, fileId } = await setup()
    await live.join(alice, fileId)
    expect((await live.join(carol, fileId)).canEdit).toBe(false)

    const events: StreamEvent[] = []
    const disconnectCarol = await live.connect(carol, fileId, 'tab-carol', 0, (e) => events.push(e))
    await flushMicro()
    expect(events.some((e) => e.event === 'peers' && e.data.some((p) => p.clientId === 'tab-carol' && !p.editing))).toBe(true)

    await expect(
      live.submit(carol, fileId, {
        clientId: 'tab-carol',
        baseSeq: 0,
        changes: [{ opId: 'c1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'A1', value: 'no' }] }], acceptLosses: false } }],
      }),
    ).rejects.toMatchObject({ code: 'forbidden' })

    // Alice edits -> Carol sees the entry over her stream at once.
    await live.submit(alice, fileId, {
      clientId: 'tab-alice',
      baseSeq: 0,
      changes: [{ opId: 'a1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'C1', value: 'hello' }] }], acceptLosses: false } }],
    })
    await flushMicro()
    expect(events.some((e) => e.event === 'entry' && e.data.seq === 1)).toBe(true)

    // Dave connects late with after=0 -> receives missed entry 1.
    const daveEvents: StreamEvent[] = []
    const disconnectDave = await live.connect(dave, fileId, 'tab-dave', 0, (e) => daveEvents.push(e))
    await flushMicro()
    expect(daveEvents.some((e) => e.event === 'entry' && e.data.seq === 1)).toBe(true)

    await disconnectCarol()
    await disconnectDave()
  })

  it('flushes as a single writer after idle pause, releases lock on close, and resets on external file replacement', async () => {
    const { live, drive, fileId, advance, fireDue } = await setup()
    await live.join(alice, fileId)
    const events: StreamEvent[] = []
    const disconnect = await live.connect(alice, fileId, 'tab-1', 0, (e) => events.push(e))
    await live.presence(alice, fileId, { clientId: 'tab-1', sheet: 'Budget', range: 'B2:C4' })
    await flushMicro()
    expect(events.some((e) => e.event === 'peers' && e.data[0]?.range === 'B2:C4')).toBe(true)

    await live.submit(alice, fileId, {
      clientId: 'tab-1',
      baseSeq: 0,
      changes: [{ opId: 'o1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B2', value: 42 }] }], acceptLosses: false } }],
    })
    advance(2_500)
    await fireDue()
    // The save runs on its own after the pause (zip + blob write): wait for it, not a fixed time.
    await vi.waitFor(() => expect(events.some((e) => e.event === 'saved' && e.data.seq === 1)).toBe(true), { timeout: 5_000 })
    const revsAfterFirstSave = await drive.listRevisions(alice, fileId)
    const lockBeforeClose = await drive.lockStatus(alice, fileId)
    expect(lockBeforeClose.state).toBe('locked')

    // More edits fold into the same revision while the live session stays open.
    await live.submit(alice, fileId, {
      clientId: 'tab-1',
      baseSeq: 1,
      changes: [{ opId: 'o2', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B3', value: 99 }] }], acceptLosses: false } }],
    })
    await disconnect()
    expect(await drive.listRevisions(alice, fileId)).toHaveLength(revsAfterFirstSave.length)
    expect((await drive.lockStatus(alice, fileId)).state).toBe('free')

    // Reopen, edit externally via upload/writeBytes while nobody holds lock -> triggers reload/reset.
    const j2 = await live.join(alice, fileId)
    expect(j2.head).toBe(2)
    await live.submit(alice, fileId, {
      clientId: 'tab-1',
      baseSeq: 2,
      changes: [{ opId: 'o3', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B4', value: 7 }] }], acceptLosses: false } }],
    })
    const events2: StreamEvent[] = []
    const disconnect2 = await live.connect(alice, fileId, 'tab-2', 2, (e) => events2.push(e))
    await drive.writeBytes(bob, fileId, budgetBook())
    await live.save(fileId)
    await flushMicro()
    expect(events2.some((e) => e.event === 'reset')).toBe(true)
    const staleSubmit = await live.submit(alice, fileId, {
      clientId: 'tab-1',
      baseSeq: 2,
      changes: [{ opId: 'o4', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B5', value: 1 }] }], acceptLosses: false } }],
    })
    expect(staleSubmit.state).toBe('reload')
    await disconnect2()
  })

  it('routes agent book/commit through open live sessions and sweeps orphaned sessions/peers', async () => {
    const { live, drive, store, fileId, advance } = await setup()
    // Without an open session, book() returns null so tools operate directly on Drive.
    expect(await live.book(alice, fileId)).toBeNull()

    await live.join(alice, fileId)
    const stream: StreamEvent[] = []
    const disconnect = await live.connect(alice, fileId, 'tab-1', 0, (e) => stream.push(e))
    // Add a stale remote peer (from another process before advancing past TTL).
    await store.putPeer(
      fileId,
      { clientId: 'remote-tab', userId: 'bob', name: 'bob', color: 1, sheet: 'Budget', range: 'A1', editing: true },
      new Date('2026-11-25T10:00:00.000Z'),
    )

    // Tool reads live bytes, commits ops into the log -> pushes to Alice immediately, defers revision write while Alice is open.
    const liveBook = await live.book(bob, fileId)
    expect(liveBook).not.toBeNull()
    const committed = await live.commit(
      bob,
      fileId,
      liveBook!.seq,
      [{ kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'D2', value: 'by-agent' }] }], acceptLosses: false }],
      'tool-1',
    )
    expect(committed).toMatchObject({ seq: 1, people: 2, saved: null })
    await flushMicro()
    expect(stream.some((e) => e.event === 'entry' && e.data.seq === 1)).toBe(true)
    expect((await store.session(fileId))?.baseSeq).toBe(0)

    // After PRESENCE_TTL_MS without heartbeat and idleMs elapsed, sweep prunes stale remote peers and flushes unsaved log.
    advance(PRESENCE_TTL_MS + 5_000)
    await live.sweep()
    expect((await store.session(fileId))?.baseSeq).toBe(1)
    expect(await store.findPeer(fileId, 'remote-tab')).toBeNull()
    const wb = openWorkbook((await drive.readFile(alice, fileId)).bytes)
    expect(wb.sheet('Budget').cells.get(cellKey(1, 3))?.value).toBe('by-agent')

    await disconnect()
    // With 0 people in the file and an active unsaved change later, commit with people === 0 saves immediately and leaves lock free.
    await live.submit(alice, fileId, {
      clientId: 'tab-offline',
      baseSeq: 1,
      changes: [{ opId: 'o1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'E2', value: 123 }] }], acceptLosses: false } }],
    })
    const orphanBook = await live.book(bob, fileId)
    expect(orphanBook?.seq).toBe(2)
    const directSave = await live.commit(
      bob,
      fileId,
      orphanBook!.seq,
      [{ kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'E3', value: 456 }] }], acceptLosses: false }],
      'tool-2',
    )
    expect(directSave.people).toBe(0)
    expect(directSave.saved).not.toBeNull()
    expect((await drive.lockStatus(alice, fileId)).state).toBe('free')
  })

  it('guards against cross-file presence spoofing and preserves explicit liveLockSession format', async () => {
    const { live, fileId } = await setup()
    await live.join(alice, fileId)
    expect(liveLockSession(fileId)).toBe(`sheet-live:${fileId}`)
    const disconnect = await live.connect(alice, fileId, 'tab-alice', 0, () => {})
    await expect(live.presence(bob, fileId, { clientId: 'tab-alice', sheet: 'Budget', range: 'A1' })).rejects.toMatchObject({ code: 'not_found' })
    await disconnect()
  })

  it('protection: the guard refuses a locked cell on the server, and a password is logged as its result, never as itself', async () => {
    const { live, fileId, store } = await setup()
    await live.join(alice, fileId)
    const change = (ops: unknown[]) => ({ kind: 'change' as const, ops: ops as never, acceptLosses: false })
    const protect = await live.submit(alice, fileId, {
      clientId: 'tab-a',
      baseSeq: 0,
      changes: [{ opId: 'p1', body: change([{ op: 'protect_sheet', sheet: 'Budget', password: 'hunter22' }]) }],
    })
    expect(protect).toMatchObject({ state: 'ok', accepted: [{ opId: 'p1', seq: 1 }] })
    const logged = await store.entriesAfter(fileId, 0, 10)
    expect(logged[0]!.body.kind).toBe('parts')
    expect(JSON.stringify(logged)).not.toContain('hunter22')

    // Bob, based before the protection, writes a locked cell: the server's guard refuses it.
    const write = await live.submit(bob, fileId, {
      clientId: 'tab-b',
      baseSeq: 0,
      changes: [{ opId: 'w1', body: change([{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B2', value: 1 }] }]) }],
    })
    expect(write).toMatchObject({ state: 'ok', accepted: [], rejected: [{ opId: 'w1', error: expect.stringMatching(/protected/i) }] })
  })

  it('refuses a comment without its time and a change logged as parts by a client', async () => {
    const { live, fileId } = await setup()
    await live.join(alice, fileId)
    const res = await live.submit(alice, fileId, {
      clientId: 'tab-a',
      baseSeq: 0,
      changes: [
        {
          opId: 'c1',
          body: {
            kind: 'change',
            ops: [{ op: 'add_comment', sheet: 'Budget', ref: 'C3', text: 'x', author: { id: 'alice', name: 'Alice' } }],
            acceptLosses: false,
          },
        },
        { opId: 'c2', body: { kind: 'parts', of: 'c1', images: {} } },
      ],
    })
    expect(res).toMatchObject({
      state: 'ok',
      accepted: [],
      rejected: [
        { opId: 'c1', error: expect.stringMatching(/needs its time/) },
        { opId: 'c2', error: expect.stringMatching(/Only the server/) },
      ],
    })
  })

  it('refuses, by name, a change that can’t be fitted after a concurrent sort', async () => {
    const { live, fileId } = await setup()
    await live.join(alice, fileId)
    await live.submit(alice, fileId, {
      clientId: 'tab-a',
      baseSeq: 0,
      changes: [{ opId: 's1', body: { kind: 'change', ops: [{ op: 'sort_range', sheet: 'Budget', range: 'A2:B3', keys: [{ col: 1 }] }], acceptLosses: true } }],
    })
    const res = await live.submit(bob, fileId, {
      clientId: 'tab-b',
      baseSeq: 0,
      changes: [{ opId: 'b1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'B3', value: 9 }] }], acceptLosses: false } }],
    })
    expect(res).toMatchObject({ state: 'ok', accepted: [], rejected: [{ opId: 'b1', error: expect.stringMatching(/Budget!A2:B3 was sorted/) }] })
  })
})
