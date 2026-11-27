import { describe, expect, it, vi } from 'vitest'
import { PresenceTracker } from '$lib/server/presence/tracker'
import { fixture, NO_COWORKERS } from '../../../../../../modules/messages/test-fixtures'

const { holder } = vi.hoisted(() => ({ holder: { deps: null as unknown, tracker: null as unknown } }))

vi.mock('../../../../../../modules/messages/live', () => ({
  messagesDeps: async () => holder.deps,
  liveWhereDrive: async () => ({ itemName: async () => null }),
}))
vi.mock('$lib/server/presence', () => ({ presence: async () => holder.tracker }))
vi.mock('$lib/server/coworkers/presence', () => ({ liveCoworkerPresence: async () => NO_COWORKERS }))

const { GET } = await import('./+server')

function event(user: { id: string } | null) {
  const ac = new AbortController()
  return { ac, event: { locals: { user }, request: new Request('https://ee.test/api/messages/presence/stream', { signal: ac.signal }) } as never }
}

describe('GET /api/messages/presence/stream', () => {
  const f = fixture()
  holder.deps = f.deps
  const tracker = new PresenceTracker(() => new Date(Date.UTC(2026, 10, 27, 9, 0, 0)))
  tracker.setShareWhereOff([])
  holder.tracker = tracker

  it('signed in only', async () => {
    expect((await GET(event(null).event)).status).toBe(401)
  })

  it('company members only (403, the one error shape)', async () => {
    const res = await GET(event({ id: 'stranger' }).event)
    expect(res.status).toBe(403)
    expect(await res.json()).toMatchObject({ code: 'forbidden' })
  })

  it('a member gets the SSE feed with the company snapshot first', async () => {
    tracker.heartbeat('carl', 'carl-tab-0001', 'active', { area: 'drive', path: '/drive', item: null })
    const { ac, event: e } = event({ id: 'bea' })
    const res = await GET(e)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()
    const dec = new TextDecoder()
    let text = ''
    while (!text.includes('"replace":true')) text += dec.decode((await reader.read()).value)
    const frame = JSON.parse(text.split('event: presence\ndata: ')[1].split('\n\n')[0]) as { people: Array<{ userId: string; where: unknown }> }
    expect(frame.people.find((p) => p.userId === 'carl')?.where).toEqual({ area: 'drive', path: '/drive', item: null })
    ac.abort()
    await reader.cancel()
  })
})
