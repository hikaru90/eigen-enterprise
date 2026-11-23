import { describe, expect, it } from 'vitest'
import { guestIdentity } from '../../../../modules/calls/state'
import { fixture } from '../../../../modules/calls/test-fixtures'
import * as chatRoute from './[id]/chat/+server'
import * as guestChatRoute from './guest/[token]/chat/+server'

/** The chat in a call over HTTP (proposal bb05b451): members by session, guests by their link. */
function wire() {
  const f = fixture()
  const service = async () => f.service
  chatRoute._deps.service = service
  guestChatRoute._deps.service = service
  return f
}

const ev = (over: Record<string, unknown>) => over as never
const post = (b: unknown) =>
  new Request('http://os.test/api/calls/x/chat', {
    method: 'POST',
    body: JSON.stringify(b),
    headers: { 'content-type': 'application/json' },
  })
const get = (query = '') => new URL(`http://os.test/api/calls/x/chat${query}`)
const tokenOf = (url: string) => decodeURIComponent(url.split('/join/')[1]!)

describe('/api/calls/[id]/chat', () => {
  it('signed in only', async () => {
    wire()
    expect(
      (await chatRoute.GET(ev({ locals: { user: null }, params: { id: 'c' }, url: get() }))).status,
    ).toBe(401)
    expect(
      (
        await chatRoute.POST(
          ev({ locals: { user: null }, params: { id: 'c' }, request: post({ body: 'x' }) }),
        )
      ).status,
    ).toBe(401)
  })

  it('POST { body } writes a line; GET reads the chat, ?since=<seq> reads on', async () => {
    const f = wire()
    const call = await f.service.start(f.user('ann'), {
      contextKind: 'dm',
      contextId: 'dm-ann-ben',
    })
    await f.service.accept('ben', call.id)
    const as = (id: string, extra: Record<string, unknown>) =>
      ev({ locals: { user: { id } }, params: { id: call.id }, ...extra })
    const res = await chatRoute.POST(as('ben', { request: post({ body: 'Hallo' }) }))
    expect(res.status).toBe(200)
    const { message } = (await res.json()) as { message: { seq: number; body: string } }
    expect(message.body).toBe('Hallo')
    await chatRoute.POST(as('ann', { request: post({ body: 'Hi Ben' }) }))
    const all = (await (await chatRoute.GET(as('ann', { url: get() }))).json()) as {
      messages: { body: string }[]
      hasMore: boolean
    }
    expect(all).toMatchObject({ messages: [{ body: 'Hallo' }, { body: 'Hi Ben' }], hasMore: false })
    const after = (await (
      await chatRoute.GET(as('ann', { url: get(`?since=${message.seq}`) }))
    ).json()) as { messages: { body: string }[] }
    expect(after.messages.map((m) => m.body)).toEqual(['Hi Ben'])
  })

  it('bad input is a 400; someone not in the conversation gets 404', async () => {
    const f = wire()
    const call = await f.service.start(f.user('ann'), {
      contextKind: 'dm',
      contextId: 'dm-ann-ben',
    })
    const as = (id: string, extra: Record<string, unknown>) =>
      ev({ locals: { user: { id } }, params: { id: call.id }, ...extra })
    expect((await chatRoute.POST(as('ann', { request: post({ body: '   ' }) }))).status).toBe(400)
    expect((await chatRoute.POST(as('ann', { request: post({ text: 'x' }) }))).status).toBe(400)
    expect((await chatRoute.GET(as('ann', { url: get('?since=abc') }))).status).toBe(400)
    expect((await chatRoute.GET(as('ann', { url: get('?since=-1') }))).status).toBe(400)
    expect((await chatRoute.GET(as('cat', { url: get() }))).status).toBe(404)
  })
})

describe('/api/calls/guest/[token]/chat', () => {
  it('a guest in the room writes as their name and reads the chat; never cached', async () => {
    const f = wire()
    const out = await f.service.schedule(f.user('ann'), {
      guests: ['kunde@example.org'],
      timeZone: 'UTC',
    })
    const token = tokenOf(out.invitations[0]!.url)
    await f.service.guestJoin(token, 'Kim Kunde')
    const refused = await guestChatRoute.POST(
      ev({ params: { token }, request: post({ body: 'zu früh' }) }),
    )
    expect(refused.status).toBe(409) // named, but not in the room yet
    await f.service.applyWebhook({
      kind: 'participant_joined',
      room: `ee-call-${out.call.id}`,
      identity: guestIdentity(out.call.guests[0]!.id),
    })
    const res = await guestChatRoute.POST(
      ev({ params: { token }, request: post({ body: 'Guten Tag' }) }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(((await res.json()) as { message: { authorName: string } }).message.authorName).toBe(
      'Kim Kunde',
    )
    const read = await guestChatRoute.GET(ev({ params: { token }, url: get('?since=0') }))
    expect(
      ((await read.json()) as { messages: { body: string }[] }).messages.map((m) => m.body),
    ).toEqual(['Guten Tag'])
    expect(
      (
        await guestChatRoute.GET(
          ev({ params: { token: 'not-a-real-guest-link-token' }, url: get() }),
        )
      ).status,
    ).toBe(404)
  })
})
