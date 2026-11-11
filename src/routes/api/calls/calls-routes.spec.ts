import { createHash } from 'node:crypto'
import { AccessToken, TokenVerifier } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'
import { isCsrfExempt, isForbiddenCrossSiteForm } from '$lib/server/csrf'
import { livekitConfig } from '../../../../modules/calls/livekit'
import { fixture, TEST_LIVEKIT_ENV } from '../../../../modules/calls/test-fixtures'
import * as callsRoute from './+server'
import * as oneRoute from './[id]/+server'
import * as acceptRoute from './[id]/accept/+server'
import * as declineRoute from './[id]/decline/+server'
import * as hangupRoute from './[id]/hangup/+server'
import * as tokenRoute from './[id]/token/+server'
import * as webhookRoute from './livekit/+server'
import * as streamRoute from './stream/+server'

/** All routes on one in-memory service (the fixture's Ann/Ben/Cat/Dan, DM dm-ann-ben). */
function wire() {
  const f = fixture()
  const service = async () => f.service
  for (const r of [callsRoute, oneRoute, acceptRoute, declineRoute, hangupRoute, tokenRoute, webhookRoute]) r._deps.service = service
  webhookRoute._deps.config = () => livekitConfig(TEST_LIVEKIT_ENV)
  return f
}

const ev = (over: Record<string, unknown>) => over as never
const post = (body: unknown) => new Request('http://os.test/api/calls', { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })

describe('/api/calls/*', () => {
  it('every route but the webhook requires a signed-in user', async () => {
    wire()
    const anon = { locals: { user: null }, params: { id: 'x' }, request: post({}) }
    const responses = await Promise.all([
      callsRoute.GET(ev(anon)),
      callsRoute.POST(ev(anon)),
      oneRoute.GET(ev(anon)),
      acceptRoute.POST(ev(anon)),
      declineRoute.POST(ev(anon)),
      hangupRoute.POST(ev(anon)),
      tokenRoute.GET(ev(anon)),
      streamRoute.GET(ev(anon)),
    ])
    expect(responses.map((r) => r.status)).toEqual([401, 401, 401, 401, 401, 401, 401, 401])
  })

  it('start → accept → token; a non-member gets 404 and no token', async () => {
    wire()
    const as = (id: string, extra: Record<string, unknown> = {}) => ({ locals: { user: { id } }, ...extra })
    const started = await callsRoute.POST(ev(as('ann', { request: post({ contextKind: 'dm', contextId: 'dm-ann-ben' }) })))
    expect(started.status).toBe(200)
    const { call } = (await started.json()) as { call: { id: string; state: string } }
    expect(call.state).toBe('ringing')
    const params = { id: call.id }
    expect((await tokenRoute.GET(ev(as('cat', { params })))).status).toBe(404)
    expect((await tokenRoute.GET(ev(as('ben', { params })))).status).toBe(409) // not accepted yet
    expect((await acceptRoute.POST(ev(as('ben', { params })))).status).toBe(200)
    const tok = await tokenRoute.GET(ev(as('ben', { params })))
    expect(tok.status).toBe(200)
    expect(tok.headers.get('cache-control')).toBe('no-store')
    const body = (await tok.json()) as { token: string; url: string; room: string }
    expect(body.url).toBe(TEST_LIVEKIT_ENV.LIVEKIT_URL)
    const claims = await new TokenVerifier(TEST_LIVEKIT_ENV.LIVEKIT_API_KEY, TEST_LIVEKIT_ENV.LIVEKIT_API_SECRET).verify(body.token)
    expect(claims).toMatchObject({ sub: 'ben', video: { roomJoin: true, room: body.room } })
    expect((await oneRoute.GET(ev(as('cat', { params })))).status).toBe(404)
    expect((await hangupRoute.POST(ev(as('ben', { params })))).status).toBe(200)
    expect((await declineRoute.POST(ev(as('cat', { params })))).status).toBe(404)
  })

  it('bad input is a 400 with the reason', async () => {
    wire()
    const res = await callsRoute.POST(ev({ locals: { user: { id: 'ann' } }, request: post({ contextKind: 'room' }) }))
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: 'invalid' })
  })

  it('LiveKit not set up → 503 "Calls are not set up on this server"', async () => {
    const f = fixture({ env: {} })
    callsRoute._deps.service = async () => f.service
    const res = await callsRoute.POST(ev({ locals: { user: { id: 'ann' } }, request: post({ contextKind: 'dm', contextId: 'dm-ann-ben' }) }))
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ code: 'not_configured', error: expect.stringContaining('Calls are not set up on this server') })
  })

  it('the webhook needs no session but a valid signature; a bad one is 401 and changes nothing', async () => {
    const f = wire()
    const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    const body = JSON.stringify({ event: 'participant_joined', room: { name: `ee-call-${call.id}` }, participant: { identity: 'ann' } })
    const at = new AccessToken(TEST_LIVEKIT_ENV.LIVEKIT_API_KEY, TEST_LIVEKIT_ENV.LIVEKIT_API_SECRET)
    at.sha256 = createHash('sha256').update(body).digest('base64')
    const jwt = await at.toJwt()
    const req = (auth: string | null) =>
      new Request('http://127.0.0.1/api/calls/livekit', {
        method: 'POST',
        body,
        headers: { 'content-type': 'application/webhook+json', ...(auth ? { authorization: auth } : {}) },
      })
    const before = structuredClone(await f.store.get(call.id))
    expect((await webhookRoute.POST(ev({ request: req(null), locals: { user: null } }))).status).toBe(401)
    expect((await webhookRoute.POST(ev({ request: req(`${jwt}x`), locals: { user: null } }))).status).toBe(401)
    expect(await f.store.get(call.id)).toEqual(before)
    const ok = await webhookRoute.POST(ev({ request: req(jwt), locals: { user: null } }))
    expect(ok.status).toBe(200)
    expect((await f.store.get(call.id))!.participants.find((p) => p.userId === 'ann')!.joinedAt).not.toBeNull()
  })

  it('only the webhook path is CSRF-exempt', () => {
    expect(isCsrfExempt('/api/calls/livekit')).toBe(true)
    for (const p of ['/api/calls', '/api/calls/abc/accept', '/api/calls/abc/token', '/api/calls/stream']) expect(isCsrfExempt(p)).toBe(false)
    const form = (path: string) =>
      new Request(`https://os.test${path}`, { method: 'POST', body: 'x', headers: { 'content-type': 'text/plain', origin: 'https://evil.test' } })
    expect(isForbiddenCrossSiteForm(form('/api/calls/livekit'), new URL('https://os.test/api/calls/livekit'))).toBe(false)
    expect(isForbiddenCrossSiteForm(form('/api/calls'), new URL('https://os.test/api/calls'))).toBe(true)
  })
})
