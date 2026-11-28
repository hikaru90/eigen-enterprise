import { describe, expect, it, vi } from 'vitest'
import type { TraceHubRuntime } from '$lib/server/traces/hub-route'
import { HubError } from '../../../../../modules/contribute/hub/errors'
import { toHubSpansV1 } from '../../../../../modules/traces/payload'
import { _deps, DELETE, POST } from './+server'
import { _deps as one, DELETE as deleteOne } from './[batchId]/+server'

const INSTALL = '11111111-1111-4111-8111-111111111111'
const BATCH = '22222222-2222-4222-8222-222222222222'
const spans = toHubSpansV1(
  [{ source: 'tool_call', localId: 'e', traceKey: null, at: new Date('2026-11-20T00:00:00Z'), tool: 'memory.list_tasks', auditClass: 'read', ok: true, via: null, durationMs: 1 }],
  { appVersion: '0.5.47', eeVersion: null, salt: 's', values: { verdict: () => 'unclassified' } },
).spans

function runtime(active = true, auth: () => Promise<{ installId: string }> = async () => ({ installId: INSTALL })): TraceHubRuntime & { insert: ReturnType<typeof vi.fn>; del: ReturnType<typeof vi.fn> } {
  const insert = vi.fn(async () => 'created' as const)
  const del = vi.fn(async () => 2)
  return {
    insert,
    del,
    active: async () => active,
    deps: async () => ({ store: { insertBatch: insert, deleteInstall: del, deleteBatch: del } as never, authenticate: auth, now: () => Date.now() }),
  }
}

const call = (handler: typeof POST, method: string, body: string, path = '/api/hub/traces', params: Record<string, string> = {}) =>
  handler({ request: new Request(`http://hub.test${path}`, { method, body: body || undefined }), url: new URL(`http://hub.test${path}`), params } as never)

describe('/api/hub/traces (plan/traces-phone-home.md T3)', () => {
  it('answers 404 while the trace-hub module is off, and stores nothing', async () => {
    const r = runtime(false)
    _deps.runtime = r
    expect((await call(POST, 'POST', '{}')).status).toBe(404)
    expect(r.insert).not.toHaveBeenCalled()
  })

  it('201 for a strict signed batch', async () => {
    _deps.runtime = runtime()
    const res = await call(POST, 'POST', JSON.stringify({ v: 1, batch_id: BATCH, spans }))
    expect(res.status).toBe(201)
  })

  it('a bad signature or replay is the Contribute hub’s 401; revoked 403', async () => {
    _deps.runtime = runtime(true, async () => {
      throw new HubError('unauthorized', 'request not accepted: replay of a request already received')
    })
    expect((await call(POST, 'POST', '{}')).status).toBe(401)
    _deps.runtime = runtime(true, async () => {
      throw new HubError('forbidden', 'revoked')
    })
    expect((await call(POST, 'POST', '{}')).status).toBe(403)
  })

  it('an extra key is a 400', async () => {
    _deps.runtime = runtime()
    const res = await call(POST, 'POST', JSON.stringify({ v: 1, batch_id: BATCH, spans: [{ ...spans[0], prompt: 'hi' }] }))
    expect(res.status).toBe(400)
  })

  it('DELETE withdraws everything, or one batch', async () => {
    const r = runtime()
    _deps.runtime = r
    one.runtime = r
    expect((await call(DELETE, 'DELETE', '')).status).toBe(200)
    expect((await call(deleteOne, 'DELETE', '', `/api/hub/traces/${BATCH}`, { batchId: BATCH })).status).toBe(200)
    expect(r.del).toHaveBeenCalledTimes(2)
  })
})
