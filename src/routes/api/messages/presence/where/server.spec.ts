import { describe, expect, it, vi } from 'vitest'
import { PresenceTracker } from '$lib/server/presence/tracker'
import { fixture } from '../../../../../../modules/messages/test-fixtures'

const { holder } = vi.hoisted(() => ({ holder: { deps: null as unknown, tracker: null as unknown, stored: new Map<string, boolean>() } }))

vi.mock('../../../../../../modules/messages/live', () => ({ messagesDeps: async () => holder.deps }))
vi.mock('$lib/server/presence', () => ({
  presence: async () => holder.tracker,
  shareWhereStore: async () => ({ set: async (userId: string, on: boolean) => void holder.stored.set(userId, on) }),
}))

const { PUT } = await import('./+server')

const put = (body: unknown, user: { id: string } | null = { id: 'bea' }) =>
  PUT({ locals: { user }, request: new Request('https://ee.test/api/messages/presence/where', { method: 'PUT', body: JSON.stringify(body) }) } as never)

describe('PUT /api/messages/presence/where ("Share where I am")', () => {
  holder.deps = fixture().deps
  const tracker = new PresenceTracker(() => new Date(Date.UTC(2026, 10, 27, 9, 0, 0)))
  tracker.setShareWhereOff([])
  holder.tracker = tracker

  it('stores the switch and answers the person’s presence', async () => {
    const res = await put({ shareWhere: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ presence: { userId: 'bea', shareWhere: false } })
    expect(holder.stored.get('bea')).toBe(false)
  })

  it('a wrong body is 400, a non-member 403, signed out 401', async () => {
    expect((await put({ shareWhere: 'off' })).status).toBe(400)
    expect((await put({ shareWhere: true }, { id: 'stranger' })).status).toBe(403)
    expect((await put({ shareWhere: true }, null)).status).toBe(401)
  })
})
