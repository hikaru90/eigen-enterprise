import { beforeEach, describe, expect, it, vi } from 'vitest'
import { InMemoryApprovalModeStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'

let admin = true
let approvalMode = new InMemoryApprovalModeStore('ask')
let eventSink = new InMemoryEventSink()
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: async () => admin }))
vi.mock('../../../../../modules/index', () => ({
  bootstrapKernel: () => ({ approvalMode, eventSink }),
}))

const { GET, PUT } = await import('./+server')

const owner = { id: 'owner-1', email: 'owner@kindred.test' }
const getReq = (user: unknown = owner) => ({ locals: { user } }) as never
const putReq = (body: string, user: unknown = owner) =>
  ({
    locals: { user },
    request: new Request('http://x/api/approvals/mode', { method: 'PUT', body }),
  }) as never

describe('/api/approvals/mode', () => {
  beforeEach(() => {
    admin = true
    approvalMode = new InMemoryApprovalModeStore('ask')
    eventSink = new InMemoryEventSink()
  })

  it('GET returns the current mode', async () => {
    const res = await GET(getReq())
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'ask' })
  })

  it('GET and PUT reject anonymous callers with 401', async () => {
    expect((await GET(getReq(null))).status).toBe(401)
    expect((await PUT(putReq('{"mode":"allow_all"}', null))).status).toBe(401)
  })

  it('PUT by a non-admin is 403 and changes nothing', async () => {
    admin = false
    const res = await PUT(putReq('{"mode":"allow_all"}'))
    expect(res.status).toBe(403)
    expect(await approvalMode.get()).toBe('ask')
    expect(eventSink.events).toHaveLength(0)
  })

  it.each(['not json', '{}', '{"mode":"yolo"}', '{"mode":1}', 'null'])(
    'PUT with bad input %s is 400',
    async (body) => {
      const res = await PUT(putReq(body))
      expect(res.status).toBe(400)
      expect(await approvalMode.get()).toBe('ask')
      expect(eventSink.events).toHaveLength(0)
    },
  )

  it('PUT by the owner persists the mode and emits an audited kernel event', async () => {
    const res = await PUT(putReq('{"mode":"reasonable"}'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ mode: 'reasonable' })
    expect(await approvalMode.get()).toBe('reasonable')
    expect(eventSink.events).toHaveLength(1)
    expect(eventSink.events[0]).toMatchObject({
      type: 'approval.mode_changed',
      principalId: 'owner-1',
      payload: { from: 'ask', to: 'reasonable' },
    })
  })
})
