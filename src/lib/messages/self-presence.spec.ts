import type { PresenceView } from './presence'
import { describe, expect, it, vi } from 'vitest'
import { SelfPresence, type SelfPresenceFetch } from './self-presence.svelte'

const view = (over: Partial<PresenceView> = {}): PresenceView => ({
  userId: 'bea',
  status: 'online',
  doNotDisturb: false,
  lastSeenAt: '2026-11-13T09:00:00.000Z',
  ...over,
})

const answer = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Lets the fetch promise chain settle. */
const settle = () => new Promise((r) => setTimeout(r, 0))

describe('SelfPresence (my own status, shown in the main nav — Contribute e4ef6be1)', () => {
  it('knows nothing until the first heartbeat answers', () => {
    const self = new SelfPresence({ fetch: vi.fn<SelfPresenceFetch>() })
    expect(self.view).toBeNull()
    expect(self.error).toBeNull()
    expect(self.saving).toBe(false)
  })

  it('a heartbeat posts to the presence route and takes the answer as my status', async () => {
    const fetch = vi.fn<SelfPresenceFetch>(async () => answer(200, { presence: view({ status: 'dnd', doNotDisturb: true }) }))
    const self = new SelfPresence({ fetch })
    self.beat({ clientId: 'tab-0123456789', state: 'active' })
    await settle()
    expect(fetch).toHaveBeenCalledWith('/api/messages/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'tab-0123456789', state: 'active' }),
      keepalive: true,
    })
    expect(self.view).toEqual(view({ status: 'dnd', doNotDisturb: true }))
  })

  it('a refused heartbeat is shown as an error, never hidden', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const self = new SelfPresence({ fetch: async () => answer(403, { error: 'only members of the company have a presence' }) })
    self.beat({ clientId: 'tab-0123456789', state: 'active' })
    await settle()
    expect(self.error).toBe('only members of the company have a presence')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('a heartbeat that cannot reach the server is shown as an error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const self = new SelfPresence({ fetch: async () => Promise.reject(new TypeError('Failed to fetch')) })
    self.beat({ clientId: 'tab-0123456789', state: 'active' })
    await settle()
    expect(self.error).toBe('Status could not be updated: Failed to fetch')
    err.mockRestore()
  })

  it('Do not disturb is saved with PUT and the answer becomes my status', async () => {
    let resolve!: (r: Response) => void
    const fetch = vi.fn<SelfPresenceFetch>(() => new Promise<Response>((r) => (resolve = r)))
    const self = new SelfPresence({ fetch })
    const saved = self.setDoNotDisturb(true)
    expect(self.saving).toBe(true)
    expect(fetch).toHaveBeenCalledWith('/api/messages/presence', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doNotDisturb: true }),
    })
    resolve(answer(200, { presence: view({ status: 'dnd', doNotDisturb: true }) }))
    await saved
    expect(self.saving).toBe(false)
    expect(self.view?.status).toBe('dnd')
  })

  it('a failed save keeps the old status and says why', async () => {
    const self = new SelfPresence({ fetch: async () => answer(500, { error: 'tracker down' }) })
    self.receive(view())
    await self.setDoNotDisturb(true)
    expect(self.view?.status).toBe('online')
    expect(self.error).toBe('tracker down')
    expect(self.saving).toBe(false)
  })

  it('a status from elsewhere (the Messages feed) replaces mine and clears an old error', async () => {
    const self = new SelfPresence({ fetch: async () => answer(500, { error: 'tracker down' }) })
    await self.setDoNotDisturb(true)
    self.receive(view({ status: 'in_call' }))
    expect(self.view?.status).toBe('in_call')
    expect(self.error).toBeNull()
  })
})
