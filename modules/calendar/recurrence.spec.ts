import { describe, expect, it } from 'vitest'
import { expandSeries, formatRrule, parseRrule, RecurrenceError, seriesEnd, type SeriesTiming } from './recurrence'

const at = (iso: string) => new Date(iso)
const iso = (xs: Array<{ start: Date; end: Date }>) => xs.map((x) => [x.start.toISOString(), x.end.toISOString()])
const starts = (xs: Array<{ start: Date }>) => xs.map((x) => x.start.toISOString())

/** Mondays 10:00–11:00 Berlin time, starting Monday 2026-11-02 (CET, UTC+1). */
const standup: SeriesTiming = {
  startsAt: at('2026-11-02T09:00:00Z'),
  endsAt: at('2026-11-02T10:00:00Z'),
  timeZone: 'Europe/Berlin',
  allDay: false,
}
const window = (from: string, to: string) => ({ from: at(from), to: at(to) })

describe('parseRrule / formatRrule', () => {
  it('reads the supported rules and writes them back the same way', () => {
    for (const text of [
      'FREQ=DAILY',
      'FREQ=DAILY;INTERVAL=2;COUNT=10',
      'FREQ=WEEKLY;BYDAY=MO,WE,FR',
      'FREQ=WEEKLY;INTERVAL=2;BYDAY=TU;UNTIL=20261231',
      'FREQ=MONTHLY;BYMONTHDAY=-1',
      'FREQ=MONTHLY;BYDAY=2TU',
      'FREQ=MONTHLY;BYDAY=-1FR;COUNT=3',
      'FREQ=YEARLY;UNTIL=20301231T230000Z',
    ]) {
      expect(formatRrule(parseRrule(text)), text).toBe(text)
    }
  })

  it('accepts an RRULE: prefix, lower case and any part order', () => {
    expect(formatRrule(parseRrule('RRULE:byday=fr,mo;freq=weekly'))).toBe('FREQ=WEEKLY;BYDAY=MO,FR')
  })

  it.each([
    ['', 'FREQ'],
    ['FREQ=HOURLY', 'FREQ'],
    ['FREQ=DAILY;INTERVAL=0', 'INTERVAL'],
    ['FREQ=DAILY;COUNT=5;UNTIL=20261231', 'COUNT and UNTIL'],
    ['FREQ=DAILY;COUNT=0', 'COUNT'],
    ['FREQ=WEEKLY;BYDAY=XX', 'BYDAY'],
    ['FREQ=WEEKLY;BYDAY=2MO', 'BYDAY'],
    ['FREQ=MONTHLY;BYDAY=MO,TU', 'BYDAY'],
    ['FREQ=MONTHLY;BYDAY=6MO', 'BYDAY'],
    ['FREQ=MONTHLY;BYMONTHDAY=32', 'BYMONTHDAY'],
    ['FREQ=MONTHLY;BYMONTHDAY=3;BYDAY=1MO', 'BYMONTHDAY'],
    ['FREQ=DAILY;BYSETPOS=1', 'BYSETPOS'],
    ['FREQ=DAILY;UNTIL=2026-12-31', 'UNTIL'],
    ['FREQ=DAILY;FREQ=WEEKLY', 'FREQ'],
  ])('refuses %j loud (names %s)', (text, part) => {
    expect(() => parseRrule(text)).toThrow(RecurrenceError)
    expect(() => parseRrule(text)).toThrow(part)
  })
})

describe('expandSeries', () => {
  it('weekly: every Monday at 10:00 Berlin time, across the end of daylight saving time in spring', () => {
    const spring: SeriesTiming = { ...standup, startsAt: at('2026-03-16T09:00:00Z'), endsAt: at('2026-03-16T10:00:00Z') }
    const out = expandSeries(spring, parseRrule('FREQ=WEEKLY'), window('2026-03-16T00:00:00Z', '2026-04-07T00:00:00Z'))
    // 29 March is the switch to CEST: the wall time stays 10:00, so UTC moves to 08:00.
    expect(iso(out)).toEqual([
      ['2026-03-16T09:00:00.000Z', '2026-03-16T10:00:00.000Z'],
      ['2026-03-23T09:00:00.000Z', '2026-03-23T10:00:00.000Z'],
      ['2026-03-30T08:00:00.000Z', '2026-03-30T09:00:00.000Z'],
      ['2026-04-06T08:00:00.000Z', '2026-04-06T09:00:00.000Z'],
    ])
  })

  it('returns only the instances that overlap the window', () => {
    const out = expandSeries(standup, parseRrule('FREQ=WEEKLY'), window('2026-11-16T09:30:00Z', '2026-11-30T09:00:00Z'))
    expect(starts(out)).toEqual(['2026-11-16T09:00:00.000Z', '2026-11-23T09:00:00.000Z'])
  })

  it('weekly on several days, every other week', () => {
    const out = expandSeries(standup, parseRrule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH'), window('2026-11-01T00:00:00Z', '2026-11-30T00:00:00Z'))
    expect(starts(out)).toEqual([
      '2026-11-02T09:00:00.000Z',
      '2026-11-05T09:00:00.000Z',
      '2026-11-16T09:00:00.000Z',
      '2026-11-19T09:00:00.000Z',
    ])
  })

  it('the first event always counts, even off the rule’s days (RFC 5545), and COUNT includes it', () => {
    const wednesday: SeriesTiming = { ...standup, startsAt: at('2026-11-04T09:00:00Z'), endsAt: at('2026-11-04T10:00:00Z') }
    const out = expandSeries(wednesday, parseRrule('FREQ=WEEKLY;BYDAY=MO;COUNT=3'), window('2026-11-01T00:00:00Z', '2027-01-01T00:00:00Z'))
    expect(starts(out)).toEqual(['2026-11-04T09:00:00.000Z', '2026-11-09T09:00:00.000Z', '2026-11-16T09:00:00.000Z'])
  })

  it('daily with COUNT, and exdates take instances out without giving them back', () => {
    const rule = parseRrule('FREQ=DAILY;COUNT=4')
    const out = expandSeries(standup, rule, window('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'), {
      exdates: [at('2026-11-03T09:00:00Z')],
    })
    expect(starts(out)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-04T09:00:00.000Z', '2026-11-05T09:00:00.000Z'])
  })

  it('UNTIL as a day is inclusive in the event’s own time zone', () => {
    const out = expandSeries(standup, parseRrule('FREQ=DAILY;UNTIL=20261104'), window('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))
    expect(starts(out)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-03T09:00:00.000Z', '2026-11-04T09:00:00.000Z'])
  })

  it('UNTIL as an instant stops at that moment', () => {
    const out = expandSeries(standup, parseRrule('FREQ=DAILY;UNTIL=20261103T090000Z'), window('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z'))
    expect(starts(out)).toEqual(['2026-11-02T09:00:00.000Z', '2026-11-03T09:00:00.000Z'])
  })

  it('monthly on the same day skips months without it; the last day and the nth weekday work', () => {
    const on31: SeriesTiming = { ...standup, startsAt: at('2026-01-31T09:00:00Z'), endsAt: at('2026-01-31T10:00:00Z') }
    expect(starts(expandSeries(on31, parseRrule('FREQ=MONTHLY;COUNT=3'), window('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')))).toEqual([
      '2026-01-31T09:00:00.000Z',
      '2026-03-31T08:00:00.000Z',
      '2026-05-31T08:00:00.000Z',
    ])
    expect(starts(expandSeries(on31, parseRrule('FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3'), window('2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z')))).toEqual([
      '2026-01-31T09:00:00.000Z',
      '2026-02-28T09:00:00.000Z',
      '2026-03-31T08:00:00.000Z',
    ])
    // Second Tuesday: 10 Nov, 8 Dec, 12 Jan.
    const tuesday: SeriesTiming = { ...standup, startsAt: at('2026-11-10T09:00:00Z'), endsAt: at('2026-11-10T10:00:00Z') }
    expect(starts(expandSeries(tuesday, parseRrule('FREQ=MONTHLY;BYDAY=2TU;COUNT=3'), window('2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z')))).toEqual([
      '2026-11-10T09:00:00.000Z',
      '2026-12-08T09:00:00.000Z',
      '2027-01-12T09:00:00.000Z',
    ])
    // Last Friday.
    const friday: SeriesTiming = { ...standup, startsAt: at('2026-11-27T09:00:00Z'), endsAt: at('2026-11-27T10:00:00Z') }
    expect(starts(expandSeries(friday, parseRrule('FREQ=MONTHLY;BYDAY=-1FR;COUNT=2'), window('2026-11-01T00:00:00Z', '2027-02-01T00:00:00Z')))).toEqual([
      '2026-11-27T09:00:00.000Z',
      '2026-12-25T09:00:00.000Z',
    ])
  })

  it('yearly on 29 February only lands in leap years', () => {
    const leap: SeriesTiming = { ...standup, startsAt: at('2028-02-29T09:00:00Z'), endsAt: at('2028-02-29T10:00:00Z') }
    expect(starts(expandSeries(leap, parseRrule('FREQ=YEARLY;COUNT=2'), window('2028-01-01T00:00:00Z', '2040-01-01T00:00:00Z')))).toEqual([
      '2028-02-29T09:00:00.000Z',
      '2032-02-29T09:00:00.000Z',
    ])
  })

  it('all-day events stay whole days in their zone, also across a daylight saving switch', () => {
    // A two-day all-day event in Berlin: 28–29 March 2026 (exclusive end 30 March 00:00 CEST).
    const away: SeriesTiming = {
      startsAt: at('2026-03-27T23:00:00Z'),
      endsAt: at('2026-03-29T22:00:00Z'),
      timeZone: 'Europe/Berlin',
      allDay: true,
    }
    const out = expandSeries(away, parseRrule('FREQ=WEEKLY;COUNT=2'), window('2026-03-01T00:00:00Z', '2026-05-01T00:00:00Z'))
    expect(iso(out)).toEqual([
      ['2026-03-27T23:00:00.000Z', '2026-03-29T22:00:00.000Z'],
      ['2026-04-03T22:00:00.000Z', '2026-04-05T22:00:00.000Z'],
    ])
  })

  it('an endless series is cut at the window end', () => {
    const out = expandSeries(standup, parseRrule('FREQ=DAILY'), window('2036-01-01T00:00:00Z', '2036-01-03T00:00:00Z'))
    expect(starts(out)).toEqual(['2036-01-01T09:00:00.000Z', '2036-01-02T09:00:00.000Z'])
  })
})

describe('seriesEnd', () => {
  it('is the end of the last instance for COUNT and UNTIL, null for an endless series', () => {
    expect(seriesEnd(standup, parseRrule('FREQ=WEEKLY;COUNT=3'))?.toISOString()).toBe('2026-11-16T10:00:00.000Z')
    expect(seriesEnd(standup, parseRrule('FREQ=DAILY;UNTIL=20261104'))?.toISOString()).toBe('2026-11-04T10:00:00.000Z')
    expect(seriesEnd(standup, parseRrule('FREQ=DAILY'))).toBeNull()
  })
})
