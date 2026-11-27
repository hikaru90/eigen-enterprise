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

const HERE = { area: 'drive', path: '/drive', item: null }

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
    const fetch = vi.fn<SelfPresenceFetch>(async () =>
      answer(200, { presence: view({ status: 'dnd', doNotDisturb: true }) }),
    )
    const self = new SelfPresence({ fetch })
    self.beat({ clientId: 'tab-0123456789', state: 'active', where: HERE })
    await settle()
    expect(fetch).toHaveBeenCalledWith('/api/messages/presence', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 'tab-0123456789', state: 'active', where: HERE }),
      keepalive: true,
    })
    expect(self.view).toEqual(view({ status: 'dnd', doNotDisturb: true }))
  })

  it('a refused heartbeat is shown as an error, never hidden', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const self = new SelfPresence({
      fetch: async () => answer(403, { error: 'only members of the company have a presence' }),
    })
    self.beat({ clientId: 'tab-0123456789', state: 'active', where: HERE })
    await settle()
    expect(self.error?.error).toBe('only members of the company have a presence')
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })

  it('a heartbeat that cannot reach the server is shown as an error', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    const self = new SelfPresence({
      fetch: async () => Promise.reject(new TypeError('Failed to fetch')),
    })
    self.beat({ clientId: 'tab-0123456789', state: 'active', where: HERE })
    await settle()
    expect(self.error?.error).toBe('Status could not be updated: Failed to fetch')
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
    const agent = {
      attempted: 'Switching Do not disturb (/api/messages)',
      nextSteps: ['Read the journal.'],
    }
    const self = new SelfPresence({
      fetch: async () => answer(500, { error: 'tracker down', agent }),
    })
    self.receive(view())
    await self.setDoNotDisturb(true)
    expect(self.view?.status).toBe('online')
    expect(self.error).toEqual({ error: 'tracker down', agent })
    expect(self.saving).toBe(false)
  })

  it('a status from elsewhere (the Messages feed) replaces mine and clears an old error', async () => {
    const self = new SelfPresence({ fetch: async () => answer(500, { error: 'tracker down' }) })
    await self.setDoNotDisturb(true)
    self.receive(view({ status: 'in_call' }))
    expect(self.view?.status).toBe('in_call')
    expect(self.error).toBeNull()
  })

  it('Share where I am is unknown until the server says it, then follows every answer', () => {
    const self = new SelfPresence({ fetch: vi.fn<SelfPresenceFetch>() })
    expect(self.shareWhere).toBeNull()
    self.receive({ ...view(), shareWhere: false })
    expect(self.shareWhere).toBe(false)
    // The Messages feed's presence carries no switch: it leaves it as it was.
    self.receive(view({ status: 'away' }))
    expect(self.shareWhere).toBe(false)
  })

  it('Share where I am is saved with PUT …/presence/where and the answer becomes my status', async () => {
    let resolve!: (r: Response) => void
    const fetch = vi.fn<SelfPresenceFetch>(() => new Promise<Response>((r) => (resolve = r)))
    const self = new SelfPresence({ fetch })
    self.receive({ ...view(), shareWhere: true })
    const saved = self.setShareWhere(false)
    expect(self.saving).toBe(true)
    expect(fetch).toHaveBeenCalledWith('/api/messages/presence/where', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ shareWhere: false }),
    })
    resolve(answer(200, { presence: { ...view(), shareWhere: false } }))
    await saved
    expect(self.saving).toBe(false)
    expect(self.shareWhere).toBe(false)
  })

  it('a refused Share where I am keeps the switch as it was and says why', async () => {
    const self = new SelfPresence({ fetch: async () => answer(500, { error: 'tracker down' }) })
    self.receive({ ...view(), shareWhere: true })
    await self.setShareWhere(false)
    expect(self.shareWhere).toBe(true)
    expect(self.error?.error).toBe('tracker down')
    expect(self.saving).toBe(false)
  })

  it('a Share where I am that cannot reach the server says so', async () => {
    const self = new SelfPresence({ fetch: async () => Promise.reject(new TypeError('Failed to fetch')) })
    await self.setShareWhere(true)
    expect(self.error?.error).toBe('Sharing where you are could not be saved: Failed to fetch')
  })
})
