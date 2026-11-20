import { describe, expect, it } from 'vitest'
import { COMPANY } from './company'
import { factsFor, fillPlaceholders, localDateOf, nextWeekdayDate, zonedToUtc } from './time'

// Thursday 2026-11-19 09:30 in Berlin (UTC+1)
const ANCHOR = new Date('2026-11-19T08:30:00Z')
const TZ = 'Europe/Berlin'

describe('fixture time: everything is relative to the run’s anchor, in the company zone', () => {
  it('the local date of an instant, shifted by whole days', () => {
    expect(localDateOf(ANCHOR, TZ, 0)).toBe('2026-11-19')
    expect(localDateOf(ANCHOR, TZ, 6)).toBe('2026-11-25')
    expect(localDateOf(new Date('2026-11-19T23:30:00Z'), TZ, 0)).toBe('2026-11-20')
  })

  it('the next given weekday strictly after the anchor’s date (5 = Friday)', () => {
    expect(nextWeekdayDate(ANCHOR, TZ, 5)).toBe('2026-11-20')
    expect(nextWeekdayDate(ANCHOR, TZ, 4)).toBe('2026-11-26')
  })

  it('a local wall-clock time in the zone as a UTC instant', () => {
    expect(zonedToUtc('2026-11-25', '10:00', TZ).toISOString()).toBe('2026-11-25T09:00:00.000Z')
    expect(zonedToUtc('2026-07-01', '10:00', TZ).toISOString()).toBe('2026-07-01T08:00:00.000Z')
  })

  it('facts render the dates questions and gold answers name', () => {
    const facts = factsFor(COMPANY, ANCHOR)
    expect(facts.investorMeeting).toBe('Wednesday 25 November 2026, 10:00–11:00')
    expect(facts.today).toBe('Thursday 19 November 2026')
  })

  it('placeholders are filled, and an unknown one fails loud', () => {
    expect(fillPlaceholders('on {today}', { today: 'Thursday' })).toBe('on Thursday')
    expect(() => fillPlaceholders('on {nope}', {})).toThrow('unknown placeholder {nope}')
  })
})
