import type { CallRecord, Guest } from './store'
import { describe, expect, it } from 'vitest'
import { guestIdentity } from './guests'
import {
  accept,
  addGuests,
  decline,
  expireWindow,
  forceEnd,
  hangup,
  inRoom,
  isLive,
  isRinging,
  joined,
  left,
  nameGuest,
  newCall,
  revokeGuest,
  roomFinished,
  sameRecord,
  timeout,
  windowClosesAt,
} from './state'

/** Windowed meetings (proposal 844bab56): open for their window instead of ringing for 45 s. */

const T0 = new Date(Date.UTC(2026, 10, 18, 9, 0, 0))
const min = (n: number) => n * 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

const guest = (id: string, over: Partial<Guest> = {}): Guest => ({
  id,
  callId: 'w1',
  email: `${id}@example.org`,
  tokenHash: id.padEnd(64, '0'),
  invitedBy: 'ann',
  invitedAt: T0,
  displayName: null,
  revokedAt: null,
  ...over,
})

function meeting(opts: { start?: Date; end?: Date; externalUrl?: string | null; invitees?: string[] } = {}): CallRecord {
  const rec = newCall({
    id: 'w1',
    roomName: 'ee-call-w1',
    contextKind: 'meeting',
    contextId: null,
    title: 'Kick-off',
    startedBy: 'ann',
    startedByParticipant: true,
    invitees: opts.invitees ?? ['ben'],
    now: T0,
    window: { start: opts.start ?? T0, end: opts.end ?? at(min(60)) },
    externalUrl: opts.externalUrl ?? null,
  })
  return addGuests(rec, [guest('g1')], T0)
}

const G1 = guestIdentity('g1')
const p = (rec: CallRecord, id: string) => rec.participants.find((x) => x.userId === id)!

describe('windowed meeting', () => {
  it('starts scheduled (live), with its window, the guest as an accepted participant', () => {
    const rec = meeting()
    expect(rec.call).toMatchObject({ state: 'scheduled', scheduledStart: T0, scheduledEnd: at(min(60)), externalUrl: null })
    expect(isLive(rec.call.state)).toBe(true)
    expect(windowClosesAt(rec)).toEqual(at(min(75)))
    expect(p(rec, G1)).toMatchObject({ response: 'accepted', joinedAt: null })
    expect(rec.guests.map((g) => g.id)).toEqual(['g1'])
  })

  it('started now it rings the colleagues; booked for later or on another provider it rings no one', () => {
    expect(isRinging(meeting(), 'ben', at(1000))).toBe(true)
    expect(isRinging(meeting(), G1, at(1000))).toBe(false)
    expect(isRinging(meeting({ start: at(min(30)), end: at(min(60)) }), 'ben', at(1000))).toBe(false)
    expect(isRinging(meeting({ externalUrl: 'https://zoom.us/j/1' }), 'ben', at(1000))).toBe(false)
  })

  it('no ring timeout: nobody answering does not make it missed', () => {
    const rec = meeting()
    expect(timeout(rec, at(min(10)))).toBe(rec)
  })

  it('the host leaving does not end it; people come and go until the window closes', () => {
    let rec = joined(meeting(), 'ann', at(1000))
    expect(rec.call.state).toBe('active')
    rec = hangup(rec, 'ann', at(2000))
    expect(rec.call.state).toBe('scheduled')
    expect(inRoom(p(rec, 'ann'))).toBe(false)
    rec = joined(rec, G1, at(min(5)))
    expect(rec.call.state).toBe('active')
    rec = left(rec, G1, at(min(6)))
    expect(rec.call.state).toBe('scheduled')
    rec = joined(rec, 'ann', at(min(7)))
    expect(rec.call.state).toBe('active')
  })

  it('declines and a closed LiveKit room keep it open inside the window', () => {
    let rec = decline(meeting(), 'ben', at(1000))
    expect(rec.call.state).toBe('scheduled')
    expect(p(rec, 'ben').response).toBe('declined')
    rec = joined(rec, 'ann', at(2000))
    rec = roomFinished(rec, at(min(20)))
    expect(rec.call.state).toBe('scheduled')
    expect(inRoom(p(rec, 'ann'))).toBe(false)
    rec = accept(rec, 'ben', at(min(21)))
    expect(p(rec, 'ben').response).toBe('accepted')
  })

  it('after the window: ends when nobody is in (ended if anyone came, missed if nobody did)', () => {
    const empty = meeting()
    expect(expireWindow(empty, at(min(75) - 1))).toBe(empty)
    expect(expireWindow(empty, at(min(75))).call).toMatchObject({ state: 'missed', endedAt: at(min(75)) })
    const came = left(joined(meeting(), G1, at(1000)), G1, at(2000))
    expect(expireWindow(came, at(min(80))).call.state).toBe('ended')
  })

  it('people still talking past the window stay; the last one out ends it', () => {
    let rec = joined(meeting(), 'ann', at(1000))
    rec = joined(rec, G1, at(2000))
    expect(expireWindow(rec, at(min(80)))).toBe(rec)
    rec = left(rec, G1, at(min(81)))
    expect(rec.call.state).toBe('active')
    rec = left(rec, 'ann', at(min(82)))
    expect(rec.call).toMatchObject({ state: 'ended', endedAt: at(min(82)) })
  })

  it('the host ends it for everyone at any time', () => {
    const rec = forceEnd(joined(meeting(), G1, at(1000)), at(min(3)))
    expect(rec.call.state).toBe('ended')
    expect(inRoom(p(rec, G1))).toBe(false)
  })

  it('guests: added, named, revoked — every change is a different record', () => {
    const rec = meeting()
    const more = addGuests(rec, [guest('g2')], at(1000))
    expect(more.guests.map((g) => g.id)).toEqual(['g1', 'g2'])
    expect(p(more, guestIdentity('g2'))).toMatchObject({ response: 'accepted', invitedAt: at(1000) })
    expect(sameRecord(rec, more)).toBe(false)
    const named = nameGuest(rec, 'g1', 'Ony Kunde')
    expect(named.guests[0]!.displayName).toBe('Ony Kunde')
    expect(sameRecord(rec, named)).toBe(false)
    const revoked = revokeGuest(rec, 'g1', at(5000))
    expect(revoked.guests[0]!.revokedAt).toEqual(at(5000))
    expect(sameRecord(rec, revoked)).toBe(false)
    expect(revokeGuest(revoked, 'g1', at(9000))).toBe(revoked)
    expect(() => addGuests(rec, [guest('g1')], at(1000))).toThrow(/already/)
  })

  it('guests only on windowed meetings', () => {
    const dm = newCall({
      id: 'c1',
      roomName: 'ee-call-c1',
      contextKind: 'dm',
      contextId: 'conv',
      title: 'Ann, Ben',
      startedBy: 'ann',
      startedByParticipant: true,
      invitees: ['ben'],
      now: T0,
    })
    expect(dm.call).toMatchObject({ state: 'ringing', scheduledStart: null, scheduledEnd: null, externalUrl: null })
    expect(dm.guests).toEqual([])
    expect(() => addGuests(dm, [guest('g9', { callId: 'c1' })], T0)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
})
