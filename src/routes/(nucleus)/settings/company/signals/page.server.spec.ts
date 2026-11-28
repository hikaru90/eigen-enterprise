import { beforeEach, describe, expect, it, vi } from 'vitest'

const { roleMock, deps } = vi.hoisted(() => ({
  roleMock: vi.fn(async (_id: string): Promise<string | null> => 'admin'),
  deps: { current: null as unknown },
}))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))
vi.mock('$lib/server/traces/live', () => ({ liveTracesDeps: async () => deps.current }))

import { memoryTraceStore } from '../../../../../../modules/traces/memory-store'
import { actions, load } from './+page.server'

const BATCH = '00000000-0000-4000-8000-000000000001'
const ev = (search = '', form?: FormData) => ({
  locals: { user: { id: 'u1' } },
  url: new URL(`http://x/settings/company/signals${search}`),
  request: new Request('http://x', { method: 'POST', body: form ?? new FormData() }),
})

describe('Settings → Company → What was sent (plan/traces-phone-home.md T4)', () => {
  let send: ReturnType<typeof vi.fn>
  beforeEach(async () => {
    roleMock.mockResolvedValue('admin')
    const store = memoryTraceStore()
    await store.createBatch(
      { id: BATCH, state: 'pending', spanCount: 2, body: { v: 1, batch_id: BATCH, spans: [] }, withheld: [], attempts: 0, nextAttemptAt: new Date(0), lastError: null, createdAt: new Date('2026-11-20T00:00:00Z'), sentAt: null, withdrawnAt: null },
      {},
    )
    await store.markSent(BATCH, new Date('2026-11-20T00:01:00Z'))
    send = vi.fn(async () => ({ status: 200, text: '' }))
    deps.current = { store, hub: { config: () => ({ ok: true }), ready: async () => ({ ok: true }), send, unauthorized: async () => {} }, now: () => new Date('2026-11-21T00:00:00Z') }
  })

  it('lists every batch and opens one exactly as sent; an admin cannot withdraw', async () => {
    const data = (await load(ev(`?batch=${BATCH}`) as never)) as { batches: unknown[]; open: { body: unknown }; canWithdraw: boolean }
    expect(data.batches).toEqual([expect.objectContaining({ id: BATCH, state: 'sent' })])
    expect(data.open.body).toEqual({ v: 1, batch_id: BATCH, spans: [] })
    expect(data.canWithdraw).toBe(false)
    expect(await actions.withdraw!(ev('', new FormData()) as never)).toMatchObject({ status: 403 })
  })

  it('the owner deletes one batch from the hub', async () => {
    roleMock.mockResolvedValue('owner')
    const f = new FormData()
    f.set('batch', BATCH)
    expect(await actions.withdraw!(ev('', f) as never)).toMatchObject({ ok: true, withdrawn: [BATCH] })
    expect(send).toHaveBeenCalledWith({ method: 'DELETE', path: `/api/hub/traces/${BATCH}`, body: '' })
  })

  it('a member is refused', async () => {
    roleMock.mockResolvedValue('member')
    await expect(load(ev() as never)).rejects.toMatchObject({ status: 403 })
  })
})
