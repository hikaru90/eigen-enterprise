import type { HubTraceStore } from './store'
import { describe, expect, it, vi } from 'vitest'
import { toHubSpansV1 } from '../payload'
import { ingestTraces, MAX_BODY_BYTES, runRetention, TraceHubError, withdrawAll, withdrawBatch, type TraceHubDeps } from './service'

const INSTALL = '11111111-1111-4111-8111-111111111111'
const BATCH = '22222222-2222-4222-8222-222222222222'
const at = new Date('2026-11-20T10:00:00Z')
const spans = toHubSpansV1(
  [{ source: 'tool_call', localId: 'e1', traceKey: null, at, tool: 'memory.list_tasks', auditClass: 'read', ok: true, via: null, durationMs: 3 }],
  { appVersion: '0.5.47', eeVersion: null, salt: 's', values: { verdict: () => 'unclassified' } },
).spans

function fakeStore() {
  const batches = new Map<string, number>()
  const store = {
    insertBatch: vi.fn(async (i: string, b: string, s: readonly unknown[]) => {
      if (batches.has(`${i}/${b}`)) return 'duplicate' as const
      batches.set(`${i}/${b}`, s.length)
      return 'created' as const
    }),
    deleteBatch: vi.fn(async () => 1),
    deleteInstall: vi.fn(async () => 3),
    rollup: vi.fn(async () => 2),
    retention: vi.fn(async () => ({ expired: 4, revoked: 0 })),
  }
  return store as unknown as HubTraceStore & typeof store
}

function deps(over: Partial<TraceHubDeps> = {}) {
  const store = fakeStore()
  const d: TraceHubDeps = { store, authenticate: vi.fn(async () => ({ installId: INSTALL })), now: () => at.getTime(), ...over }
  return { d, store }
}

const req = (body: string, method = 'POST', path = '/api/hub/traces') => ({ method, path, headers: new Headers(), body })
const good = JSON.stringify({ v: 1, batch_id: BATCH, spans })

describe('the makers’ hub ingest (plan/traces-phone-home.md T3)', () => {
  it('stores a strict batch once: 201, then 200 duplicate (idempotent by batch id)', async () => {
    const { d, store } = deps()
    expect(await ingestTraces(d, req(good))).toMatchObject({ status: 201, body: { outcome: 'created', spans: 1 } })
    expect(await ingestTraces(d, req(good))).toMatchObject({ status: 200, body: { outcome: 'duplicate' } })
    expect(store.insertBatch).toHaveBeenCalledWith(INSTALL, BATCH, spans, at)
  })

  it('a bad signature is refused before the body is read', async () => {
    const authenticate = vi.fn(async () => {
      throw new Error('request not accepted: signature')
    })
    const { d, store } = deps({ authenticate })
    await expect(ingestTraces(d, req('not json'))).rejects.toThrow(/signature/)
    expect(store.insertBatch).not.toHaveBeenCalled()
  })

  it('an extra key anywhere is a 400 and nothing is stored', async () => {
    const { d, store } = deps()
    const extra = JSON.stringify({ v: 1, batch_id: BATCH, spans: [{ ...spans[0], context: 'Jane emailed Acme' }] })
    await expect(ingestTraces(d, req(extra))).rejects.toMatchObject({ code: 'invalid' })
    await expect(ingestTraces(d, req(JSON.stringify({ v: 1, batch_id: BATCH, spans, x: 1 })))).rejects.toBeInstanceOf(TraceHubError)
    expect(store.insertBatch).not.toHaveBeenCalled()
  })

  it('an oversize body is a 413 before it is parsed', async () => {
    const { d } = deps()
    await expect(ingestTraces(d, req('x'.repeat(MAX_BODY_BYTES + 1)))).rejects.toMatchObject({ code: 'too_large' })
  })

  it('more than 500 spans is refused', async () => {
    const { d } = deps()
    const many = JSON.stringify({ v: 1, batch_id: BATCH, spans: Array.from({ length: 501 }, () => spans[0]) })
    await expect(ingestTraces(d, req(many))).rejects.toMatchObject({ code: 'invalid' })
  })

  it('withdraw: everything of the signing install, or one batch; a DELETE carries no body', async () => {
    const { d, store } = deps()
    expect(await withdrawAll(d, req('', 'DELETE'))).toEqual({ status: 200, body: { deleted: 3 } })
    expect(store.deleteInstall).toHaveBeenCalledWith(INSTALL)
    expect(await withdrawBatch(d, req('', 'DELETE'), BATCH)).toEqual({ status: 200, body: { deleted: 1 } })
    await expect(withdrawAll(d, req('{}', 'DELETE'))).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('hub retention (T3)', () => {
  it('rolls up every day before today, then drops raw spans older than 90 days', async () => {
    const { d, store } = deps()
    expect(await runRetention(d)).toEqual({ rolledUp: 2, expired: 4, revoked: 0 })
    expect(store.rollup).toHaveBeenCalledWith('2026-11-20')
    expect(store.retention).toHaveBeenCalledWith('2026-08-22')
  })
})
