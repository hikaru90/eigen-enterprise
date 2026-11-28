import type { CallDto } from './client'
import { describe, expect, it } from 'vitest'
import { callClock, callLineLabel, durationLabel, historyOf, readingTurns } from './format'

describe('durationLabel', () => {
  it('whole minutes (at least one), hours past an hour', () => {
    expect(durationLabel(0)).toBe('1 min')
    expect(durationLabel(20)).toBe('1 min')
    expect(durationLabel(245)).toBe('4 min')
    expect(durationLabel(3600)).toBe('1 h')
    expect(durationLabel(3900)).toBe('1 h 5 min')
  })
})

describe('callClock (the running clock in the call)', () => {
  const since = '2026-11-19T10:00:00.000Z'
  const at = (ms: number) => Date.parse(since) + ms
  it('mm:ss under an hour, h:mm:ss from an hour on', () => {
    expect(callClock(since, at(0))).toBe('00:00')
    expect(callClock(since, at(999))).toBe('00:00')
    expect(callClock(since, at(65_000))).toBe('01:05')
    expect(callClock(since, at(3_599_999))).toBe('59:59')
    expect(callClock(since, at(3_600_000))).toBe('1:00:00')
    expect(callClock(since, at(3_725_000))).toBe('1:02:05')
    expect(callClock(since, at(36_000_000 + 61_000))).toBe('10:01:01')
  })
  it('a browser clock a little behind the server never shows a negative time', () => {
    expect(callClock(since, at(-4_000))).toBe('00:00')
  })
})

describe('readingTurns (the transcript page)', () => {
  const seg = (seq: number, speakerId: string, startedAt: string, text: string) => ({
    seq,
    speakerId,
    speakerKind: 'member' as const,
    speakerName: speakerId.toUpperCase(),
    startedAt: `2026-11-19T10:${startedAt}.000Z`,
    endedAt: `2026-11-19T10:${startedAt}.000Z`,
    text,
  })
  it('one speaker in a row is one turn, its time from the call start (mm:ss)', () => {
    const turns = readingTurns([seg(1, 'a', '00:30', 'eins'), seg(2, 'a', '01:00', 'zwei'), seg(3, 'b', '01:05', 'drei'), seg(4, 'a', '02:00', 'vier')], '2026-11-19T10:00:00.000Z', [])
    expect(turns).toEqual([
      {
        key: 's1',
        speakerName: 'A',
        guest: false,
        chat: false,
        at: '00:30',
        text: 'eins zwei',
        image: null,
      },
      {
        key: 's3',
        speakerName: 'B',
        guest: false,
        chat: false,
        at: '01:05',
        text: 'drei',
        image: null,
      },
      {
        key: 's4',
        speakerName: 'A',
        guest: false,
        chat: false,
        at: '02:00',
        text: 'vier',
        image: null,
      },
    ])
  })

  it('chat lines join the transcript by time, each its own turn, marked as chat (a spoken turn around it is split)', () => {
    const line = (seq: number, authorId: string, at: string, body: string, authorKind: 'member' | 'guest' = 'member') => ({
      seq,
      authorId,
      authorKind,
      authorName: authorId.toUpperCase(),
      body,
      image: null,
      createdAt: `2026-11-19T10:${at}.000Z`,
    })
    const turns = readingTurns(
      [seg(1, 'a', '00:30', 'eins'), seg(2, 'a', '01:00', 'zwei')],
      '2026-11-19T10:00:00.000Z',
      [line(9, 'a', '00:45', 'getippt'), line(10, 'guest:k', '03:00', 'Hallo', 'guest')],
    )
    expect(turns).toEqual([
      {
        key: 's1',
        speakerName: 'A',
        guest: false,
        chat: false,
        at: '00:30',
        text: 'eins',
        image: null,
      },
      {
        key: 'c9',
        speakerName: 'A',
        guest: false,
        chat: true,
        at: '00:45',
        text: 'getippt',
        image: null,
      },
      {
        key: 's2',
        speakerName: 'A',
        guest: false,
        chat: false,
        at: '01:00',
        text: 'zwei',
        image: null,
      },
      {
        key: 'c10',
        speakerName: 'GUEST:K',
        guest: true,
        chat: true,
        at: '03:00',
        text: 'Hallo',
        image: null,
      },
    ])
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
