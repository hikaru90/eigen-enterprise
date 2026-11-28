import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { budgetBook } from '$lib/office/xlsx/test-utils/build-xlsx'
import { createSheetLive, type SheetLive } from '$lib/server/sheet-live/service'
import { memorySheetLiveStore } from '$lib/server/sheet-live/store'
import { memoryEditLockStore } from '../../../../../../../modules/drive/locks'
import { memoryDriveAccess } from '../../../../../../../modules/drive/memory-access'
import { createDriveService } from '../../../../../../../modules/drive/service'
import { diskBlobStore } from '../../../../../../../modules/drive/storage'
import { memoryDriveStore } from '../../../../../../../modules/drive/store'

const state = vi.hoisted(() => ({ live: null as SheetLive | null }))

vi.mock('$lib/server/sheet-live/live', () => ({
  sheetLiveListening: async () => state.live!,
  sheetLive: async () => state.live!,
}))

const joinRoute = await import('./join/+server')
const submitRoute = await import('./submit/+server')
const presenceRoute = await import('./presence/+server')
const entriesRoute = await import('./entries/+server')
const streamRoute = await import('./stream/+server')

const dirs: string[] = []
afterEach(async () => {
  state.live?.stop()
  state.live = null
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true })
})

describe('/api/drive/files/[id]/sheet-live/* routes', () => {
  let fileId = ''
  const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

  beforeEach(async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sheet-live-routes-'))
    dirs.push(dir)
    const access = memoryDriveAccess({
      users: {
        alice: { role: 'member', name: 'Alice' },
        viewer: { role: 'member', name: 'Viewer' },
      },
    })
    const drive = createDriveService({
      store: memoryDriveStore(),
      blobs: diskBlobStore(dir, Buffer.alloc(32, 7)),
      access,
      maxUploadBytes: 1 << 22,
      locks: memoryEditLockStore(),
    })
    const store = memorySheetLiveStore()
    const live: SheetLive = createSheetLive({
      drive,
      store,
      publish: async (m) => live.receive(m),
      nameOf: async (a) => (a.kind === 'user' ? a.userId : a.id),
    })
    state.live = live
    const folder = await drive.createFolder({ kind: 'user', userId: 'alice' }, null, 'Workbooks')
    access.grants.push({
      resourceType: 'folder',
      resourceId: folder.id,
      subject: { kind: 'user', userId: 'viewer' },
      level: 'view',
    })
    const uploaded = await drive.upload({ kind: 'user', userId: 'alice' }, folder.id, { name: 'book.xlsx', bytes: budgetBook(), mime: XLSX }, 'fail')
    fileId = uploaded.id
  })

  const eventFor = (userId: string | null, opts: { method?: string; path?: string; body?: unknown; signal?: AbortSignal } = {}) => {
    const url = new URL(`http://localhost/api/drive/files/${fileId}/sheet-live/${opts.path ?? 'join'}`)
    const request = new Request(url, {
      method: opts.method ?? 'POST',
      ...(opts.body !== undefined ? { body: JSON.stringify(opts.body), headers: { 'content-type': 'application/json' } } : {}),
      signal: opts.signal,
    })
    return {
      locals: { user: userId ? { id: userId } : null },
      params: { id: fileId },
      url,
      request,
    } as never
  }

  it('rejects unauthenticated callers on all endpoints with 401', async () => {
    await expect(joinRoute.POST(eventFor(null))).rejects.toMatchObject({ status: 401 })
    await expect(submitRoute.POST(eventFor(null, { path: 'submit', body: {} }))).rejects.toMatchObject({ status: 401 })
    await expect(presenceRoute.POST(eventFor(null, { path: 'presence', body: {} }))).rejects.toMatchObject({ status: 401 })
    await expect(entriesRoute.GET(eventFor(null, { method: 'GET', path: 'entries' }))).rejects.toMatchObject({ status: 401 })
    await expect(streamRoute.GET(eventFor(null, { method: 'GET', path: 'stream?clientId=c1' }))).rejects.toMatchObject({ status: 401 })
  })

  it('allows join, entries, presence, submit for editors and restricts viewers to read-only SSE updates', async () => {
    const joinRes = await joinRoute.POST(eventFor('alice'))
    expect(joinRes.status).toBe(200)
    expect(await joinRes.json()).toMatchObject({ canEdit: true, baseSeq: 0, head: 0 })

    // Viewer can join with canEdit: false and open the SSE stream, but gets 403 on submit.
    const viewerJoin = await joinRoute.POST(eventFor('viewer'))
    expect(viewerJoin.status).toBe(200)
    expect(await viewerJoin.json()).toMatchObject({ canEdit: false })

    const ac = new AbortController()
    const streamRes = await streamRoute.GET(
      eventFor('viewer', { method: 'GET', path: 'stream?clientId=v-tab&after=0', signal: ac.signal }),
    )
    expect(streamRes.status).toBe(200)
    expect(streamRes.headers.get('content-type')).toBe('text/event-stream')
    const reader = streamRes.body!.getReader()
    const dec = new TextDecoder()

    const viewerSubmit = await submitRoute.POST(
      eventFor('viewer', {
        path: 'submit',
        body: {
          clientId: 'v-tab',
          baseSeq: 0,
          changes: [{ opId: 'x1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'A1', value: 1 }] }], acceptLosses: false } }],
        },
      }),
    )
    expect(viewerSubmit.status).toBe(403)

    // Editor submits an op -> viewer's SSE stream receives it.
    const editorSubmit = await submitRoute.POST(
      eventFor('alice', {
        path: 'submit',
        body: {
          clientId: 'a-tab',
          baseSeq: 0,
          changes: [{ opId: 'a1', body: { kind: 'change', ops: [{ op: 'set_cells', sheet: 'Budget', cells: [{ ref: 'C1', value: 'live!' }] }], acceptLosses: false } }],
        },
      }),
    )
    expect(editorSubmit.status).toBe(200)
    expect(await editorSubmit.json()).toMatchObject({ state: 'ok', head: 1 })

    // Frames may arrive split across reads: read until the entry came (or the stream ended).
    let text = ''
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      text += dec.decode(value)
      if (text.includes('event: entry') && text.includes('"live!"')) break
    }
    expect(text).toContain('event: peers')
    expect(text).toContain('event: entry')
    expect(text).toContain('"live!"')

    // Entries endpoint catches up from after=0.
    const entriesRes = await entriesRoute.GET(eventFor('viewer', { method: 'GET', path: 'entries?after=0' }))
    expect(entriesRes.status).toBe(200)
    expect((await entriesRes.json()).entries).toHaveLength(1)

    // Viewer presence works while connected; cleanup on abort works cleanly.
    const presRes = await presenceRoute.POST(
      eventFor('viewer', { path: 'presence', body: { clientId: 'v-tab', sheet: 'Budget', range: 'B2' } }),
    )
    expect(presRes.status).toBe(200)

    ac.abort()
    await reader.cancel()
    await new Promise((r) => setTimeout(r, 30))
  })

  it('validates payloads and query parameters cleanly with 400 errors', async () => {
    const badSubmit = await submitRoute.POST(
      eventFor('alice', { path: 'submit', body: { clientId: '', baseSeq: -1, changes: [] } }),
    )
    expect(badSubmit.status).toBe(400)

    // An operation name the SheetOp union does not have is refused, never logged.
    const unknownOp = await submitRoute.POST(
      eventFor('alice', {
        path: 'submit',
        body: {
          clientId: 'tab-a',
          baseSeq: 0,
          changes: [{ opId: 'x1', body: { kind: 'change', ops: [{ op: 'set_comment', sheet: 'S' }], acceptLosses: false } }],
        },
      }),
    )
    expect(unknownOp.status).toBe(400)

    const badAfter = await entriesRoute.GET(eventFor('alice', { method: 'GET', path: 'entries?after=abc' }))
    expect(badAfter.status).toBe(400)

    const badStream = await streamRoute.GET(eventFor('alice', { method: 'GET', path: 'stream?after=0' }))
    expect(badStream.status).toBe(400)

    const outsiderJoin = await joinRoute.POST(eventFor('outsider'))
    expect(outsiderJoin.status).toBe(404)
  })
})
