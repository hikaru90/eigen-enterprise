import { describe, expect, it } from 'vitest'
import { dueOccurrences, nextOccurrence, ReminderScheduleError, validateSchedule, type WeeklySchedule } from './schedule'

/** Monday and Thursday, 09:00 Berlin — the proposal's LinkedIn rhythm. */
const monThu: WeeklySchedule = { weekdays: ['MO', 'TH'], time: '09:00', timeZone: 'Europe/Berlin' }

describe('validateSchedule', () => {
  it('normalizes weekdays Monday first, without duplicates', () => {
    expect(validateSchedule({ weekdays: ['TH', 'MO', 'TH'], time: '09:00', timeZone: 'Europe/Berlin' })).toEqual(monThu)
  })

  it('refuses an empty weekday list, an unknown weekday, a malformed time and an unknown time zone', () => {
    expect(() => validateSchedule({ ...monThu, weekdays: [] })).toThrow(ReminderScheduleError)
    expect(() => validateSchedule({ ...monThu, weekdays: ['MON' as never] })).toThrow(/weekday/)
    expect(() => validateSchedule({ ...monThu, time: '9:00' })).toThrow(/HH:MM/)
    expect(() => validateSchedule({ ...monThu, time: '24:00' })).toThrow(/HH:MM/)
    expect(() => validateSchedule({ ...monThu, timeZone: 'Mars/Olympus' })).toThrow(/time zone/)
  })
})

describe('nextOccurrence', () => {
  it('is the next chosen weekday at the wall time in the person’s zone', () => {
    // Saturday 2026-11-21 12:00 UTC → Monday 2026-11-23 09:00 CET (08:00 UTC).
    expect(nextOccurrence(monThu, new Date('2026-11-21T12:00:00Z'))).toEqual(new Date('2026-11-23T08:00:00Z'))
  })

  it('is later the same day when the time has not come yet, and strictly after the given instant', () => {
    expect(nextOccurrence(monThu, new Date('2026-11-23T07:59:00Z'))).toEqual(new Date('2026-11-23T08:00:00Z'))
    expect(nextOccurrence(monThu, new Date('2026-11-23T08:00:00Z'))).toEqual(new Date('2026-11-26T08:00:00Z'))
  })

  it('keeps the wall time across daylight saving (09:00 CEST = 07:00 UTC in summer)', () => {
    // Saturday 2026-03-28: Berlin switches to CEST on Sunday 2026-03-29.
    expect(nextOccurrence(monThu, new Date('2026-03-28T12:00:00Z'))).toEqual(new Date('2026-03-30T07:00:00Z'))
  })
})

describe('dueOccurrences', () => {
  it('counts every occurrence after the handled mark up to now, oldest first', () => {
    // Handled through Sunday 2026-11-15; now Friday 2026-11-27 10:00 UTC → Mon 16, Thu 19, Mon 23, Thu 26.
    const due = dueOccurrences(monThu, new Date('2026-11-15T12:00:00Z'), new Date('2026-11-27T10:00:00Z'))
    expect(due).toEqual({ oldest: new Date('2026-11-16T08:00:00Z'), latest: new Date('2026-11-26T08:00:00Z'), count: 4 })
  })

  it('includes an occurrence exactly at now and excludes one exactly at the handled mark', () => {
    const at = new Date('2026-11-23T08:00:00Z')
    expect(dueOccurrences(monThu, new Date('2026-11-22T00:00:00Z'), at)?.count).toBe(1)
    expect(dueOccurrences(monThu, at, at)).toBeNull()
  })

  it('is null before the first occurrence', () => {
    expect(dueOccurrences(monThu, new Date('2026-11-21T12:00:00Z'), new Date('2026-11-23T07:59:59Z'))).toBeNull()
  })

  it('walks a long absence without failing (a year of a daily reminder)', () => {
    const daily: WeeklySchedule = { weekdays: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'], time: '08:30', timeZone: 'UTC' }
    const due = dueOccurrences(daily, new Date('2025-11-21T09:00:00Z'), new Date('2026-11-21T09:00:00Z'))
    expect(due?.count).toBe(365)
  })
})
