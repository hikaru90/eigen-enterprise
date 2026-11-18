import { TokenVerifier } from 'livekit-server-sdk'
import { describe, expect, it } from 'vitest'
import { hashGuestToken } from './guests'
import { GUEST_ATTRIBUTE } from './livekit'
import { fixture, TEST_LIVEKIT_ENV } from './test-fixtures'

/** Meetings with guests from outside the company (proposal 844bab56). */

const verify = (token: string) => new TokenVerifier(TEST_LIVEKIT_ENV.LIVEKIT_API_KEY, TEST_LIVEKIT_ENV.LIVEKIT_API_SECRET).verify(token)
const min = (n: number) => n * 60_000
const tokenOf = (url: string) => decodeURIComponent(url.split('/join/')[1]!)

describe('scheduling a meeting with guests', () => {
  it('now: every guest gets a personal link and an email; the meeting is open for 60 min + 15', async () => {
    const f = fixture()
    const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org', 'amt@behoerde.de'], timeZone: 'Europe/Berlin' })
    const t0 = f.clock.now()
    expect(out.call).toMatchObject({
      contextKind: 'meeting',
      state: 'scheduled',
      title: 'Meeting with kunde@example.org, amt@behoerde.de',
      scheduledStart: t0.toISOString(),
      scheduledEnd: new Date(t0.getTime() + min(60)).toISOString(),
      closesAt: new Date(t0.getTime() + min(75)).toISOString(),
      externalUrl: null,
    })
    expect(out.call.guests.map((g) => [g.email, g.name, g.revoked])).toEqual([
      ['kunde@example.org', null, false],
      ['amt@behoerde.de', null, false],
    ])
    expect(out.mailConfigured).toBe(true)
    expect(out.invitations).toHaveLength(2)
    for (const inv of out.invitations) {
      expect(inv.url).toMatch(/^https:\/\/os\.example\.test\/join\/[A-Za-z0-9_-]{43,}$/)
      expect(inv).toMatchObject({ emailed: true, error: null })
    }
    expect(out.invitations[0]!.url).not.toBe(out.invitations[1]!.url)
    expect(f.mail.sent.map((m) => m.to)).toEqual(['kunde@example.org', 'amt@behoerde.de'])
    expect(f.mail.sent[0]!.text).toContain(out.invitations[0]!.url)
    expect(f.mail.sent[0]!.replyTo).toBe('ann@co.test')
    // Only the hash is stored.
    const stored = f.store.records.get(out.call.id)!
    const token = tokenOf(out.invitations[0]!.url)
    expect(stored.guests[0]!.tokenHash).toBe(hashGuestToken(token))
    expect(JSON.stringify([...f.store.records.values()])).not.toContain(token)
  })

  it('booked for later with a duration; colleagues invited too (not rung for a later meeting)', async () => {
    const f = fixture()
    const startsAt = new Date(f.clock.now().getTime() + min(120))
    const out = await f.service.schedule(f.user('ann'), { userIds: ['ben'], guests: ['kunde@example.org'], startsAt, durationMinutes: 30, title: 'Kick-off', timeZone: 'UTC' })
    expect(out.call).toMatchObject({ title: 'Kick-off', scheduledStart: startsAt.toISOString(), scheduledEnd: new Date(startsAt.getTime() + min(30)).toISOString() })
    expect(out.call.participants.map((p) => [p.userId, p.guest])).toEqual([
      ['ann', false],
      ['ben', false],
      [`guest:${out.call.guests[0]!.id}`, true],
    ])
    expect((await f.service.liveViews('ben')).map((v) => v.ringing)).toEqual([false])
  })

  it('email not set up: the meeting and the links exist, nothing is sent, and the result says so', async () => {
    const f = fixture()
    f.mail.configured = false
    const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org'], timeZone: 'UTC' })
    expect(out.mailConfigured).toBe(false)
    expect(out.invitations[0]).toMatchObject({ emailed: false, error: null })
    expect(out.invitations[0]!.url).toContain('/join/')
    expect(f.mail.sent).toEqual([])
  })

  it('a failing send is reported for that guest; the others still go out', async () => {
    const f = fixture()
    f.mail.failFor.add('kunde@example.org')
    const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org', 'amt@behoerde.de'], timeZone: 'UTC' })
    expect(out.invitations.map((i) => [i.email, i.emailed, i.error])).toEqual([
      ['kunde@example.org', false, 'SES said no'],
      ['amt@behoerde.de', true, null],
    ])
  })

  it('refuses bad input before anything is stored', async () => {
    const f = fixture()
    const bad = [
      { timeZone: 'UTC' },
      { guests: ['not-an-email'], timeZone: 'UTC' },
      { guests: ['a@b.de'], durationMinutes: 600, timeZone: 'UTC' },
      { guests: ['a@b.de'], startsAt: new Date(f.clock.now().getTime() - min(60)), timeZone: 'UTC' },
      { guests: ['a@b.de'], timeZone: 'Nowhere/Land' },
      { guests: ['a@b.de'], externalUrl: 'javascript:alert(1)', timeZone: 'UTC' },
      { userIds: ['ghost'], timeZone: 'UTC' },
    ]
    for (const input of bad) await expect(f.service.schedule(f.user('ann'), input as never)).rejects.toMatchObject({ code: 'invalid' })
    await expect(f.service.schedule(f.user('stranger'), { guests: ['a@b.de'], timeZone: 'UTC' })).rejects.toMatchObject({ code: 'forbidden' })
    expect(f.store.records.size).toBe(0)
    expect(f.mail.sent).toEqual([])
  })

  it('LiveKit not set up: refused — unless the meeting is on another provider', async () => {
    const f = fixture({ env: {} })
    await expect(f.service.schedule(f.user('ann'), { guests: ['a@b.de'], timeZone: 'UTC' })).rejects.toMatchObject({ code: 'not_configured' })
    const out = await f.service.schedule(f.user('ann'), { guests: ['a@b.de'], externalUrl: 'https://zoom.us/j/123', timeZone: 'UTC' })
    expect(out.call.externalUrl).toBe('https://zoom.us/j/123')
  })
})

describe('another provider’s call link', () => {
  it('stores and shows the link; the invitation carries it; nobody rings and no room token is handed out', async () => {
    const f = fixture()
    const out = await f.service.schedule(f.user('ann'), { userIds: ['ben'], guests: ['kunde@example.org'], externalUrl: 'https://teams.example.com/l/m', timeZone: 'UTC' })
    expect(out.call.externalUrl).toBe('https://teams.example.com/l/m')
    expect(out.invitations[0]!.url).toBe('https://teams.example.com/l/m')
    expect(f.mail.sent[0]!.text).toContain('https://teams.example.com/l/m')
    expect((await f.service.liveViews('ben'))[0]!.ringing).toBe(false)
    await f.service.accept('ben', out.call.id)
    await expect(f.service.token('ben', out.call.id)).rejects.toMatchObject({ code: 'conflict' })
  })
})

describe('the guest link', () => {
  async function booked(f = fixture(), startsInMin = 60) {
    const startsAt = new Date(f.clock.now().getTime() + min(startsInMin))
    const out = await f.service.schedule(f.user('ann'), { guests: ['kunde@example.org'], startsAt, durationMinutes: 30, title: 'Kick-off', timeZone: 'UTC' })
    return { f, out, token: tokenOf(out.invitations[0]!.url) }
  }

  it('unknown → not found; the page view says when it opens', async () => {
    const { f, token, out } = await booked()
    await expect(f.service.guestView('nope')).rejects.toMatchObject({ code: 'not_found' })
    expect(await f.service.guestView(token)).toMatchObject({
      status: 'too_early',
      title: 'Kick-off',
      hostName: 'Ann Example',
      opensAt: new Date(new Date(out.call.scheduledStart!).getTime() - min(15)).toISOString(),
      closesAt: out.call.closesAt,
    })
    await expect(f.service.guestJoin(token, 'Ony')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('inside the window: a guest token for this room only, labelled a guest; the call shows them as "Guest"', async () => {
    const { f, token, out } = await booked()
    f.clock.tick(min(46))
    expect((await f.service.guestView(token)).status).toBe('ok')
    const joined = await f.service.guestJoin(token, '  Ony Kunde ')
    const guestId = out.call.guests[0]!.id
    expect(joined.identity).toBe(`guest:${guestId}`)
    expect(joined.token.room).toBe(`ee-call-${out.call.id}`)
    const claims = await verify(joined.token.token)
    expect(claims).toMatchObject({ sub: `guest:${guestId}`, name: 'Ony Kunde', attributes: { [GUEST_ATTRIBUTE]: 'guest' }, video: { room: joined.token.room, canPublishData: false } })
    expect(claims.video?.roomAdmin).toBeFalsy()
    // The guest's own view of the call names nobody's email.
    expect(joined.call.guests).toEqual([])
    expect(JSON.stringify(joined.call)).not.toContain('kunde@example.org')
    await f.service.applyWebhook({ kind: 'participant_joined', room: joined.token.room, identity: joined.identity })
    const seen = await f.service.get('ann', out.call.id)
    expect(seen.state).toBe('active')
    expect(seen.participants.find((p) => p.guest)).toMatchObject({ name: 'Ony Kunde', guest: true, inRoom: true })
    expect(seen.guests[0]).toMatchObject({ name: 'Ony Kunde', inRoom: true })
  })

  it('expires 15 minutes after the scheduled end', async () => {
    const { f, token } = await booked()
    f.clock.tick(min(60 + 30 + 15))
    expect((await f.service.guestView(token)).status).toBe('expired')
    await expect(f.service.guestJoin(token, 'Ony')).rejects.toMatchObject({ code: 'conflict' })
  })

  it('a guest link never reaches the signed-in routes, and a guest cannot use another call', async () => {
    const { f, out, token } = await booked()
    const other = await booked(f)
    f.clock.tick(min(46))
    const joined = await f.service.guestJoin(token, 'Ony')
    await expect(f.service.get(joined.identity, out.call.id)).rejects.toMatchObject({ code: 'not_found' })
    await expect(f.service.token(joined.identity, other.out.call.id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('the host revokes a guest: the link stops working and they are removed from the room', async () => {
    const { f, out, token } = await booked()
    f.clock.tick(min(46))
    const joined = await f.service.guestJoin(token, 'Ony')
    await f.service.applyWebhook({ kind: 'participant_joined', room: joined.token.room, identity: joined.identity })
    const guestId = out.call.guests[0]!.id
    await expect(f.service.revokeGuest('ben', out.call.id, guestId)).rejects.toMatchObject({ code: 'not_found' })
    const after = await f.service.revokeGuest('ann', out.call.id, guestId)
    expect(after.guests[0]).toMatchObject({ revoked: true })
    expect(f.removed).toEqual([[joined.token.room, joined.identity]])
    expect((await f.service.guestView(token)).status).toBe('revoked')
    await expect(f.service.guestJoin(token, 'Ony')).rejects.toMatchObject({ code: 'forbidden' })
  })

  it('only the host may revoke or invite more; more guests get their own links', async () => {
    const f = fixture()
    const out = await f.service.schedule(f.user('ann'), { userIds: ['ben'], guests: ['kunde@example.org'], timeZone: 'UTC' })
    await expect(f.service.revokeGuest('ben', out.call.id, out.call.guests[0]!.id)).rejects.toMatchObject({ code: 'forbidden' })
    await expect(f.service.inviteGuests('ben', out.call.id, { guests: ['x@example.org'], timeZone: 'UTC' })).rejects.toMatchObject({ code: 'forbidden' })
    const more = await f.service.inviteGuests('ann', out.call.id, { guests: ['partner@example.org', 'kunde@example.org'], timeZone: 'UTC' })
    expect(more.invitations.map((i) => i.email)).toEqual(['partner@example.org'])
    expect(more.call.guests.map((g) => g.email)).toEqual(['kunde@example.org', 'partner@example.org'])
  })

  it('guests cannot be added to a DM call', async () => {
    const f = fixture()
    const call = await f.service.start(f.user('ann'), { contextKind: 'dm', contextId: 'dm-ann-ben' })
    await expect(f.service.inviteGuests('ann', call.id, { guests: ['x@example.org'], timeZone: 'UTC' })).rejects.toMatchObject({ code: 'invalid' })
  })

  it('the sweep ends a window that closed with nobody in it', async () => {
    const { f, out } = await booked()
    f.clock.tick(min(60 + 30 + 15))
    expect(await f.service.expireWindows()).toBe(1)
    expect(f.store.records.get(out.call.id)!.call.state).toBe('missed')
    expect(f.closed).toContain(`ee-call-${out.call.id}`)
  })

  it('a guest leaving is leaving the room; the meeting stays open', async () => {
    const { f, token } = await booked()
    f.clock.tick(min(46))
    const joined = await f.service.guestJoin(token, 'Ony')
    await f.service.applyWebhook({ kind: 'participant_joined', room: joined.token.room, identity: joined.identity })
    const after = await f.service.guestLeave(token)
    expect(after.state).toBe('scheduled')
    expect((await f.service.guestCall(token)).participants.find((p) => p.guest)?.inRoom).toBe(false)
  })
})
