import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { _deps, GET, POST } from './+server'

type Ev = Parameters<typeof GET>[0]
const ev = (user: { id: string } | null, body?: unknown) =>
  ({
    locals: { user },
    request: new Request('http://x/api/notifications', { method: body === undefined ? 'GET' : 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  }) as unknown as Ev

describe('/api/notifications (the bell): a client of notifications.inbox / .mark_read', () => {
  it('GET runs notifications.inbox as the signed-in person', async () => {
    const run = vi.fn(async () => ({ items: [], unread: 0 }))
    _deps.run = run as never
    const res = await GET(ev({ id: 'u1' }))
    expect(await res.json()).toEqual({ items: [], unread: 0 })
    expect(run).toHaveBeenCalledWith({ id: 'u1' }, 'notifications.inbox', {})
  })

  it('POST runs notifications.mark_read with the keys; a bad key is a 400', async () => {
    const run = vi.fn(async () => ({ items: [], unread: 0 }))
    _deps.run = run as never
    await POST(ev({ id: 'u1' }, { keys: ['question:q1'] }))
    expect(run).toHaveBeenCalledWith({ id: 'u1' }, 'notifications.mark_read', { keys: ['question:q1'] })
    _deps.run = (async () => {
      throw new KernelError('invalid_input', 'Not in your inbox: x')
    }) as never
    await expect(POST(ev({ id: 'u1' }, { keys: ['x'] }))).rejects.toMatchObject({ status: 400 })
  })

  it('refuses signed-out callers', async () => {
    await expect(GET(ev(null))).rejects.toMatchObject({ status: 401 })
  })
})
