import { describe, expect, it } from 'vitest'
import { isForbiddenCrossSiteForm } from '$lib/server/csrf'
import { fixture } from '../../../../modules/calls/test-fixtures'
import * as inviteRoute from './[id]/guests/+server'
import * as revokeRoute from './[id]/guests/[guestId]/+server'
import * as guestRoute from './guest/[token]/+server'
import * as joinRoute from './guest/[token]/join/+server'
import * as leaveRoute from './guest/[token]/leave/+server'
import * as meetingsRoute from './meetings/+server'

/** Meetings with guests over HTTP (proposal 844bab56), on one in-memory service. */
function wire() {
  const f = fixture()
  const service = async () => f.service
  for (const r of [meetingsRoute, inviteRoute, revokeRoute, guestRoute, joinRoute, leaveRoute]) r._deps.service = service
  return f
}

const ev = (over: Record<string, unknown>) => over as never
const body = (b: unknown, method = 'POST') =>
  new Request('http://os.test/api/calls/meetings', { method, body: JSON.stringify(b), headers: { 'content-type': 'application/json' } })
const as = (id: string | null, extra: Record<string, unknown> = {}) => ({ locals: { user: id ? { id } : null }, params: {}, ...extra })
const tokenOf = (url: string) => decodeURIComponent(url.split('/join/')[1]!)

async function schedule(f: ReturnType<typeof wire>, input: Record<string, unknown>) {
  const res = await meetingsRoute.POST(ev(as('ann', { request: body({ timeZone: 'Europe/Berlin', ...input }) })))
  return { res, out: (await res.json()) as { call: { id: string; guests: { id: string }[] }; invitations: { url: string; emailed: boolean }[]; mailConfigured: boolean } }
}

describe('/api/calls/meetings', () => {
  it('signed in only', async () => {
    wire()
    const res = await meetingsRoute.POST(ev(as(null, { request: body({ guests: ['a@b.de'], timeZone: 'UTC' }) })))
    expect(res.status).toBe(401)
  })

  it('schedules with guests and returns each link once', async () => {
    const f = wire()
    const startsAt = new Date(f.clock.now().getTime() + 3_600_000).toISOString()
    const { res, out } = await schedule(f, { guests: ['kunde@example.org'], startsAt, durationMinutes: 45, title: 'Kick-off' })
    expect(res.status).toBe(200)
    expect(out.invitations[0]!.url).toMatch(/\/join\//)
    expect(out.mailConfigured).toBe(true)
  })

  it('bad input is a 400 naming the problem', async () => {
    const f = wire()
    for (const input of [
      { guests: ['nope'] },
      { guests: ['a@b.de'], startsAt: 'tomorrow-ish' },
      { guests: ['a@b.de'], durationMinutes: '60' },
      { guests: ['a@b.de'], externalUrl: 'ftp://x' },
      { guests: 'a@b.de' },
      { guests: ['a@b.de'], timeZone: 42 },
    ]) {
      const { res, out } = await schedule(f, input)
      expect(res.status, JSON.stringify(input)).toBe(400)
      expect(out).toMatchObject({ code: 'invalid' })
    }
  })

  it('email not set up: 200 with the links, mailConfigured false', async () => {
    const f = wire()
    f.mail.configured = false
    const { res, out } = await schedule(f, { guests: ['kunde@example.org'] })
    expect(res.status).toBe(200)
    expect(out).toMatchObject({ mailConfigured: false, invitations: [{ emailed: false }] })
  })
})

describe('/api/calls/[id]/guests', () => {
  it('the host invites more and revokes; anyone else is refused', async () => {
    const f = wire()
    const { out } = await schedule(f, { userIds: ['ben'], guests: ['kunde@example.org'] })
    const params = { id: out.call.id }
    const more = await inviteRoute.POST(ev(as('ann', { params, request: body({ guests: ['partner@example.org'], timeZone: 'UTC' }) })))
    expect(more.status).toBe(200)
    expect(((await more.json()) as { invitations: unknown[] }).invitations).toHaveLength(1)
    expect((await inviteRoute.POST(ev(as('ben', { params, request: body({ guests: ['x@example.org'], timeZone: 'UTC' }) })))).status).toBe(403)
    const guestId = out.call.guests[0]!.id
    expect((await revokeRoute.DELETE(ev(as('ben', { params: { ...params, guestId } })))).status).toBe(403)
    expect((await revokeRoute.DELETE(ev(as('cat', { params: { ...params, guestId } })))).status).toBe(404)
    const revoked = await revokeRoute.DELETE(ev(as('ann', { params: { ...params, guestId } })))
    expect(revoked.status).toBe(200)
    expect(await revoked.json()).toMatchObject({ call: { guests: [{ id: guestId, revoked: true }, { revoked: false }] } })
  })
})

describe('/api/calls/guest/[token] (public: the token is the proof)', () => {
  it('unknown → 404; inside the window: view, join with a name (guest token, no-store), leave', async () => {
    const f = wire()
    const { out } = await schedule(f, { guests: ['kunde@example.org'] })
    const token = tokenOf(out.invitations[0]!.url)
    expect((await guestRoute.GET(ev(as(null, { params: { token: 'x'.repeat(43) } })))).status).toBe(404)
    const view = await guestRoute.GET(ev(as(null, { params: { token } })))
    expect(view.status).toBe(200)
    expect(view.headers.get('cache-control')).toBe('no-store')
    expect((await joinRoute.POST(ev(as(null, { params: { token }, request: body({ name: '  ' }) })))).status).toBe(400)
    const joined = await joinRoute.POST(ev(as(null, { params: { token }, request: body({ name: 'Ony Kunde' }) })))
    expect(joined.status).toBe(200)
    expect(joined.headers.get('cache-control')).toBe('no-store')
    const j = (await joined.json()) as { identity: string; token: { token: string; room: string } }
    expect(j.identity).toMatch(/^guest:/)
    expect(j.token.room).toBe(`ee-call-${out.call.id}`)
    const left = await leaveRoute.POST(ev(as(null, { params: { token } })))
    expect(left.status).toBe(200)
  })

  it('expired → 409 with the reason; the guest join is JSON (not a cross-site form)', async () => {
    const f = wire()
    const { out } = await schedule(f, { guests: ['kunde@example.org'] })
    const token = tokenOf(out.invitations[0]!.url)
    f.clock.tick(76 * 60_000)
    const res = await joinRoute.POST(ev(as(null, { params: { token }, request: body({ name: 'Ony' }) })))
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ code: 'conflict', error: 'this guest link has expired' })
    const form = new Request('http://os.test/api/calls/guest/t/join', { method: 'POST', body: 'name=x', headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' } })
    expect(isForbiddenCrossSiteForm(form, new URL(form.url))).toBe(true)
  })
})
