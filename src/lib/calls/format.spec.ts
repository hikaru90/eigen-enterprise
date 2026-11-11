import type { CallDto } from './client'
import { describe, expect, it } from 'vitest'
import { callLineLabel, durationLabel, historyOf } from './format'

describe('durationLabel', () => {
  it('whole minutes (at least one), hours past an hour', () => {
    expect(durationLabel(0)).toBe('1 min')
    expect(durationLabel(20)).toBe('1 min')
    expect(durationLabel(245)).toBe('4 min')
    expect(durationLabel(3600)).toBe('1 h')
    expect(durationLabel(3900)).toBe('1 h 5 min')
  })
})

describe('callLineLabel (the line in a DM/channel)', () => {
  it('Call, n min / Missed call / Declined call', () => {
    expect(callLineLabel({ callId: 'c', outcome: 'ended', durationSeconds: 245 })).toBe('Call, 4 min')
    expect(callLineLabel({ callId: 'c', outcome: 'missed', durationSeconds: null })).toBe('Missed call')
    expect(callLineLabel({ callId: 'c', outcome: 'declined', durationSeconds: null })).toBe('Declined call')
  })
})

const base: CallDto = {
  id: 'c1',
  contextKind: 'dm',
  contextId: 'dm1',
  title: 'Ann Example, Ben Example',
  startedBy: 'ann',
  startedByName: 'Ann Example',
  state: 'ended',
  startedAt: '2026-11-11T09:00:00.000Z',
  answeredAt: '2026-11-11T09:00:05.000Z',
  endedAt: '2026-11-11T09:04:05.000Z',
  ringUntil: '2026-11-11T09:00:45.000Z',
  participants: [
    { userId: 'ann', name: 'Ann Example', response: 'accepted', joinedAt: '2026-11-11T09:00:01.000Z', leftAt: '2026-11-11T09:04:05.000Z', inRoom: false },
    { userId: 'ben', name: 'Ben Example', response: 'accepted', joinedAt: '2026-11-11T09:00:05.000Z', leftAt: '2026-11-11T09:04:05.000Z', inRoom: false },
  ],
}

describe('historyOf (the calls page, as one person sees a call)', () => {
  it('an answered call: its duration, outgoing for the caller and incoming for the other', () => {
    expect(historyOf(base, 'ann')).toEqual({ outcome: 'Call, 4 min', tone: 'normal', direction: 'outgoing', live: false })
    expect(historyOf(base, 'ben')).toMatchObject({ outcome: 'Call, 4 min', direction: 'incoming' })
  })

  it('missed: "Missed" for the person called, "No answer" for the caller', () => {
    const missed = { ...base, state: 'missed' as const, answeredAt: null }
    expect(historyOf(missed, 'ben')).toMatchObject({ outcome: 'Missed', tone: 'missed' })
    expect(historyOf(missed, 'ann')).toMatchObject({ outcome: 'No answer', tone: 'muted' })
  })

  it('declined: "You declined" for the person who did, "Declined" for the caller', () => {
    const declined = { ...base, state: 'declined' as const, answeredAt: null }
    expect(historyOf(declined, 'ben')).toMatchObject({ outcome: 'You declined', tone: 'muted' })
    expect(historyOf(declined, 'ann')).toMatchObject({ outcome: 'Declined', tone: 'muted' })
  })

  it('a group call others had without me: missed (or declined) for me', () => {
    const channel: CallDto = {
      ...base,
      contextKind: 'channel',
      participants: [...base.participants, { userId: 'cat', name: 'Cat', response: 'none', joinedAt: null, leftAt: null, inRoom: false }],
    }
    expect(historyOf(channel, 'cat')).toMatchObject({ outcome: 'Missed', tone: 'missed' })
    const said = { ...channel, participants: channel.participants.map((p) => (p.userId === 'cat' ? { ...p, response: 'declined' as const } : p)) }
    expect(historyOf(said, 'cat')).toMatchObject({ outcome: 'You declined' })
  })

  it('a live call: ringing or in progress', () => {
    expect(historyOf({ ...base, state: 'ringing', answeredAt: null, endedAt: null }, 'ben')).toMatchObject({ outcome: 'Ringing', live: true })
    expect(historyOf({ ...base, state: 'active', endedAt: null }, 'ben')).toMatchObject({ outcome: 'In progress', live: true })
  })
})
