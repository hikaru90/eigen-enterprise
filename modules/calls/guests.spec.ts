import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_DURATION_MINUTES,
  guestJoinUrl,
  guestLinkStatus,
  guestWindow,
  hashGuestToken,
  invitationEmail,
  MAX_GUESTS,
  newGuestToken,
  parseExternalUrl,
  parseGuestEmails,
  parseGuestName,
  parseTimeZone,
  scheduleOf,
} from './guests'
import { addGuests, forceEnd, newCall, revokeGuest, WINDOW_EARLY_MS, WINDOW_GRACE_MS } from './state'

const T0 = new Date(Date.UTC(2026, 10, 18, 9, 0, 0))
const min = (n: number) => n * 60_000
const at = (ms: number) => new Date(T0.getTime() + ms)

function booked() {
  const rec = newCall({
    id: 'c1',
    roomName: 'ee-call-c1',
    contextKind: 'meeting',
    contextId: null,
    title: 'Kick-off',
    startedBy: 'ann',
    startedByParticipant: true,
    invitees: [],
    now: T0,
    window: { start: at(min(60)), end: at(min(90)) },
  })
  return addGuests(
    rec,
    [{ id: 'g1', callId: 'c1', email: 'kunde@example.org', tokenHash: hashGuestToken('t1'), invitedBy: 'ann', invitedAt: T0, displayName: null, revokedAt: null }],
    T0,
  )
}

describe('guest link tokens', () => {
  it('are long, random, url-safe; only their SHA-256 is kept', () => {
    const a = newGuestToken()
    const b = newGuestToken()
    expect(a.token).toMatch(/^[A-Za-z0-9_-]{43,}$/)
    expect(a.token).not.toBe(b.token)
    expect(a.tokenHash).toBe(createHash('sha256').update(a.token).digest('hex'))
    expect(a.tokenHash).toMatch(/^[0-9a-f]{64}$/)
    expect(hashGuestToken(a.token)).toBe(a.tokenHash)
  })

  it('the guest page link carries the token in its path', () => {
    expect(guestJoinUrl('https://os.example.test/', 'abc_-1')).toBe('https://os.example.test/join/abc_-1')
  })
})

describe('schedule', () => {
  it('now: starts now and runs the default duration', () => {
    expect(scheduleOf({ startsAt: null }, T0)).toEqual({ start: T0, end: at(min(DEFAULT_DURATION_MINUTES)) })
    expect(DEFAULT_DURATION_MINUTES).toBe(60)
  })

  it('booked: the chosen start and duration', () => {
    expect(scheduleOf({ startsAt: at(min(120)), durationMinutes: 30 }, T0)).toEqual({ start: at(min(120)), end: at(min(150)) })
  })

  it('refuses durations outside 5 min – 8 h, starts in the past or more than a year ahead', () => {
    for (const durationMinutes of [0, 4, 481, 30.5, Number.NaN]) {
      expect(() => scheduleOf({ startsAt: null, durationMinutes }, T0)).toThrow(expect.objectContaining({ code: 'invalid' }))
    }
    expect(() => scheduleOf({ startsAt: at(-min(6)) }, T0)).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(scheduleOf({ startsAt: at(-min(4)) }, T0).start).toEqual(at(-min(4)))
    expect(() => scheduleOf({ startsAt: at(min(60 * 24 * 366)) }, T0)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
})

describe('guest window', () => {
  it('opens 15 minutes before the start and closes 15 minutes after the scheduled end', () => {
    expect(WINDOW_EARLY_MS).toBe(min(15))
    expect(WINDOW_GRACE_MS).toBe(min(15))
    expect(guestWindow(booked().call)).toEqual({ opensAt: at(min(45)), closesAt: at(min(105)) })
  })

  it('link status over time: too early → ok → expired', () => {
    const rec = booked()
    const g = rec.guests[0]!
    expect(guestLinkStatus(rec, g, at(min(45) - 1))).toBe('too_early')
    expect(guestLinkStatus(rec, g, at(min(45)))).toBe('ok')
    expect(guestLinkStatus(rec, g, at(min(105) - 1))).toBe('ok')
    expect(guestLinkStatus(rec, g, at(min(105)))).toBe('expired')
  })

  it('a revoked link is revoked; a call ended early by its host is over', () => {
    const rec = booked()
    const revoked = revokeGuest(rec, 'g1', at(min(50)))
    expect(guestLinkStatus(revoked, revoked.guests[0]!, at(min(60)))).toBe('revoked')
    const ended = forceEnd(rec, at(min(70)))
    expect(guestLinkStatus(ended, ended.guests[0]!, at(min(71)))).toBe('over')
  })
})

describe('input', () => {
  it('guest emails: trimmed, lower-cased, de-duplicated; every bad one is named', () => {
    expect(parseGuestEmails([' Kunde@Example.org ', 'kunde@example.org', 'amt@behoerde.de'])).toEqual(['kunde@example.org', 'amt@behoerde.de'])
    expect(() => parseGuestEmails(['ok@example.org', 'nope', 'also@'])).toThrow(/nope, also@/)
    expect(() => parseGuestEmails('a@b.de')).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => parseGuestEmails(Array.from({ length: MAX_GUESTS + 1 }, (_, i) => `g${i}@example.org`))).toThrow(expect.objectContaining({ code: 'invalid' }))
  })

  it('another provider’s link: http(s) only', () => {
    expect(parseExternalUrl(' https://zoom.us/j/123?pwd=x ')).toBe('https://zoom.us/j/123?pwd=x')
    expect(parseExternalUrl('http://meet.example.org/abc')).toBe('http://meet.example.org/abc')
    for (const bad of ['javascript:alert(1)', 'ftp://x.org/a', 'zoom.us/j/1', '', `https://x.org/${'a'.repeat(2000)}`]) {
      expect(() => parseExternalUrl(bad)).toThrow(expect.objectContaining({ code: 'invalid' }))
    }
  })

  it('a guest name: 1–80 characters, trimmed', () => {
    expect(parseGuestName('  Ony Kunde ')).toBe('Ony Kunde')
    expect(() => parseGuestName('   ')).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => parseGuestName('x'.repeat(81))).toThrow(expect.objectContaining({ code: 'invalid' }))
    expect(() => parseGuestName(7)).toThrow(expect.objectContaining({ code: 'invalid' }))
  })

  it('a time zone must be a real IANA zone', () => {
    expect(parseTimeZone('Europe/Berlin')).toBe('Europe/Berlin')
    expect(() => parseTimeZone('Mars/Olympus')).toThrow(expect.objectContaining({ code: 'invalid' }))
  })
})

describe('the invitation email', () => {
  it('says who, what, when (in the host’s zone) and carries the link; HTML is escaped', () => {
    const mail = invitationEmail({
      companyName: 'Kindred Digital Labs',
      hostName: 'Ann Example',
      title: 'Kick-off <b>',
      start: at(min(60)),
      end: at(min(90)),
      timeZone: 'Europe/Berlin',
      url: 'https://os.example.test/join/tok',
      external: false,
    })
    expect(mail.subject).toBe('Ann Example invited you to a video call: Kick-off <b>')
    expect(mail.text).toContain('https://os.example.test/join/tok')
    expect(mail.text).toContain('11:00') // 10:00 UTC = 11:00 in Berlin (CET)
    expect(mail.text).toMatch(/no account/i)
    expect(mail.html).toContain('Kick-off &lt;b&gt;')
    expect(mail.html).not.toContain('<b>')
    expect(mail.html).toContain('href="https://os.example.test/join/tok"')
  })

  it('for another provider’s link it sends that link', () => {
    const mail = invitationEmail({
      companyName: null,
      hostName: 'Ann Example',
      title: 'Review',
      start: T0,
      end: at(min(30)),
      timeZone: 'UTC',
      url: 'https://teams.example.com/l/meetup',
      external: true,
    })
    expect(mail.text).toContain('https://teams.example.com/l/meetup')
    expect(mail.text).not.toMatch(/no account/i)
  })
})
