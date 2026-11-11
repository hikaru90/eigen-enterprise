import type { CallRecord } from './store'
import { describe, expect, it } from 'vitest'
import {
  accept,
  decline,
  forceEnd,
  hangup,
  inRoom,
  isRinging,
  joined,
  left,
  newCall,
  RING_TIMEOUT_MS,
  roomFinished,
  sameRecord,
  timeout,
} from './state'

const T0 = new Date(Date.UTC(2026, 10, 11, 9, 0, 0))
const at = (s: number) => new Date(T0.getTime() + s * 1000)

function dm(): CallRecord {
  return newCall({
    id: 'c1',
    roomName: 'ee-call-c1',
    contextKind: 'dm',
    contextId: 'conv-1',
    title: 'Ann, Ben',
    startedBy: 'ann',
    startedByParticipant: true,
    invitees: ['ben'],
    now: T0,
  })
}

const p = (rec: CallRecord, userId: string) => rec.participants.find((x) => x.userId === userId)!

describe('call state machine', () => {
  it('a new call rings: the starter has accepted, everyone else has not answered yet', () => {
    const rec = dm()
    expect(rec.call.state).toBe('ringing')
    expect(p(rec, 'ann').response).toBe('accepted')
    expect(p(rec, 'ben').response).toBe('none')
    expect(isRinging(rec, 'ben', at(1))).toBe(true)
    expect(isRinging(rec, 'ann', at(1))).toBe(false)
  })

  it('ringing → active → ended: the callee joins, then the last person out ends it', () => {
    let rec = dm()
    rec = joined(rec, 'ann', at(1))
    expect(rec.call.state).toBe('ringing') // the caller alone in the room is still ringing
    rec = accept(rec, 'ben', at(5))
    expect(rec.call.state).toBe('ringing') // accepting is intent; the webhook says who is really in
    rec = joined(rec, 'ben', at(6))
    expect(rec.call.state).toBe('active')
    expect(isRinging(rec, 'ben', at(7))).toBe(false)
    rec = left(rec, 'ann', at(60))
    expect(rec.call.state).toBe('active')
    rec = left(rec, 'ben', at(61))
    expect(rec.call).toMatchObject({ state: 'ended', endedAt: at(61) })
    expect(rec.participants.some(inRoom)).toBe(false)
  })

  it('a DM: either person hanging up ends it for both (owner decision 2026-11-11)', () => {
    const connected = () => joined(accept(joined(dm(), 'ann', at(1)), 'ben', at(5)), 'ben', at(6))
    expect(connected().call.state).toBe('active')
    expect(hangup(connected(), 'ben', at(90)).call).toMatchObject({ state: 'ended', endedAt: at(90) })
    expect(hangup(connected(), 'ann', at(90)).call).toMatchObject({ state: 'ended', endedAt: at(90) })
  })

  it('a DM: a network drop (webhook left) is not a hang-up — the call waits for the reconnect', () => {
    let rec = joined(accept(joined(dm(), 'ann', at(1)), 'ben', at(5)), 'ben', at(6))
    rec = left(rec, 'ben', at(30))
    expect(rec.call.state).toBe('active')
    rec = joined(rec, 'ben', at(35))
    expect(rec.call.state).toBe('active')
  })

  it('a DM: hanging up after a drop still ends it for both', () => {
    let rec = joined(accept(joined(dm(), 'ann', at(1)), 'ben', at(5)), 'ben', at(6))
    rec = left(rec, 'ben', at(30))
    expect(hangup(rec, 'ben', at(31)).call).toMatchObject({ state: 'ended', endedAt: at(31) })
  })

  it('timeout → missed: nobody answered within the ring window', () => {
    let rec = joined(dm(), 'ann', at(1))
    expect(timeout(rec, at(RING_TIMEOUT_MS / 1000 - 1))).toBe(rec)
    rec = timeout(rec, at(RING_TIMEOUT_MS / 1000))
    expect(rec.call).toMatchObject({ state: 'missed', endedAt: at(RING_TIMEOUT_MS / 1000) })
    expect(p(rec, 'ann').leftAt).toEqual(at(RING_TIMEOUT_MS / 1000)) // the waiting caller is out
    expect(isRinging(rec, 'ben', at(1))).toBe(false)
  })

  it('a timeout never touches an answered call', () => {
    const rec = joined(joined(dm(), 'ann', at(1)), 'ben', at(2))
    expect(timeout(rec, at(600))).toBe(rec)
  })

  it('the callee declining a 1:1 call → declined', () => {
    const rec = decline(dm(), 'ben', at(3))
    expect(rec.call).toMatchObject({ state: 'declined', endedAt: at(3) })
    expect(p(rec, 'ben').response).toBe('declined')
  })

  it('a group call stays ringing until every invitee has declined', () => {
    let rec = newCall({
      id: 'c2', roomName: 'r2', contextKind: 'channel', contextId: 'ch', title: '#general',
      startedBy: 'ann', startedByParticipant: true, invitees: ['ben', 'cat'], now: T0,
    })
    rec = decline(rec, 'ben', at(1))
    expect(rec.call.state).toBe('ringing')
    rec = decline(rec, 'cat', at(2))
    expect(rec.call.state).toBe('declined')
  })

  it('a group call keeps going when one person declines and another joins', () => {
    let rec = newCall({
      id: 'c2', roomName: 'r2', contextKind: 'channel', contextId: 'ch', title: '#general',
      startedBy: 'ann', startedByParticipant: true, invitees: ['ben', 'cat'], now: T0,
    })
    rec = joined(rec, 'ann', at(1))
    rec = decline(rec, 'ben', at(2))
    rec = joined(rec, 'cat', at(3))
    expect(rec.call.state).toBe('active')
  })

  it('the caller hanging up while it rings cancels it: missed for the callee', () => {
    const rec = hangup(joined(dm(), 'ann', at(1)), 'ann', at(4))
    expect(rec.call).toMatchObject({ state: 'missed', endedAt: at(4) })
  })

  it('the callee hanging up before joining is a decline', () => {
    expect(hangup(dm(), 'ben', at(2)).call.state).toBe('declined')
  })

  it('the caller leaving the room before anyone answered (webhook) → missed', () => {
    const rec = left(joined(dm(), 'ann', at(1)), 'ann', at(9))
    expect(rec.call.state).toBe('missed')
  })

  it('rejoining after a drop clears left_at and keeps the first join time', () => {
    let rec = joined(joined(dm(), 'ann', at(1)), 'ben', at(2))
    rec = left(rec, 'ann', at(10))
    rec = joined(rec, 'ann', at(12))
    expect(p(rec, 'ann')).toMatchObject({ joinedAt: at(1), leftAt: null })
    expect(rec.call.state).toBe('active')
  })

  it('someone who was never invited joining the room changes nothing (fail closed)', () => {
    const rec = joined(dm(), 'ann', at(1))
    expect(joined(rec, 'mallory', at(2))).toBe(rec)
  })

  it('room_finished ends an answered call and marks an unanswered one missed', () => {
    const answered = roomFinished(joined(joined(dm(), 'ann', at(1)), 'ben', at(2)), at(30))
    expect(answered.call).toMatchObject({ state: 'ended', endedAt: at(30) })
    expect(answered.participants.some(inRoom)).toBe(false)
    expect(roomFinished(joined(dm(), 'ann', at(1)), at(30)).call.state).toBe('missed')
  })

  it('forceEnd (calls.end) ends a live call; ended calls never change again', () => {
    const ended = forceEnd(joined(joined(dm(), 'ann', at(1)), 'ben', at(2)), at(20))
    expect(ended.call.state).toBe('ended')
    expect(joined(ended, 'ben', at(21))).toBe(ended)
    expect(left(ended, 'ben', at(21))).toBe(ended)
    expect(roomFinished(ended, at(21))).toBe(ended)
    expect(timeout(ended, at(999))).toBe(ended)
    expect(decline(ended, 'ben', at(21))).toBe(ended)
    expect(() => accept(ended, 'ben', at(21))).toThrow(expect.objectContaining({ code: 'conflict' }))
  })

  it('an agent-started meeting: the agent is no participant, the first joiner makes it active', () => {
    let rec = newCall({
      id: 'm', roomName: 'rm', contextKind: 'meeting', contextId: null, title: 'Standup',
      startedBy: 'agent:orchestrator', startedByParticipant: false, invitees: ['ann', 'ben'], now: T0,
    })
    expect(rec.participants.map((x) => x.userId)).toEqual(['ann', 'ben'])
    expect(isRinging(rec, 'ann', at(1))).toBe(true)
    rec = joined(rec, 'ann', at(2))
    expect(rec.call.state).toBe('active')
  })

  it('both people starting a call to each other at once: accepting the existing call answers it', () => {
    // The service hands the second starter the live call of the context; their accept is the answer.
    const rec = accept(dm(), 'ben', at(1))
    expect(p(rec, 'ben').response).toBe('accepted')
    expect(isRinging(rec, 'ben', at(2))).toBe(false)
    expect(rec.call.state).toBe('ringing')
  })

  it('sameRecord compares values, not identity', () => {
    const a = dm()
    expect(sameRecord(a, structuredClone(a))).toBe(true)
    expect(sameRecord(a, accept(a, 'ben', at(1)))).toBe(false)
  })
})
