import { describe, expect, it } from 'vitest'
import { dayItems, parseView, placeTimed, shiftDate, viewDays, viewHeading } from './layout'

const ev = (start: string, end: string, allDay = false) => ({ start, end, allDay })

describe('views', () => {
  it('reads the view from the address: week when none, refused when unknown', () => {
    expect(parseView(null)).toBe('week')
    expect(parseView('month')).toBe('month')
    expect(() => parseView('year')).toThrow('day, week or month')
  })

  it('a day, the Monday-to-Sunday week, and six whole weeks for a month', () => {
    expect(viewDays('day', '2026-11-18')).toEqual(['2026-11-18'])
    expect(viewDays('week', '2026-11-18')).toEqual(['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'])
    const month = viewDays('month', '2026-11-18')
    expect([month.length, month[0], month.at(-1)]).toEqual([42, '2026-10-26', '2026-12-06'])
  })

  it('previous / next move by a day, a week or a month', () => {
    expect(shiftDate('day', '2026-11-30', 1)).toBe('2026-12-01')
    expect(shiftDate('week', '2026-11-18', -1)).toBe('2026-11-11')
    expect(shiftDate('month', '2026-01-31', 1)).toBe('2026-02-01')
  })

  it('names what is shown', () => {
    expect(viewHeading('day', '2026-11-18')).toBe('Wednesday, 18 November 2026')
    expect(viewHeading('week', '2026-11-18')).toBe('16 – 22 November 2026')
    expect(viewHeading('week', '2026-11-30')).toBe('30 November – 6 December 2026')
    expect(viewHeading('month', '2026-11-18')).toBe('November 2026')
  })
})

describe('placing events on a day (Berlin)', () => {
  const tz = 'Europe/Berlin'

  it('splits all-day from timed; a timed event over several days is all-day on the days it fills', () => {
    const items = [
      ev('2026-11-17T23:00:00.000Z', '2026-11-18T23:00:00.000Z', true),
      ev('2026-11-18T09:00:00.000Z', '2026-11-18T10:00:00.000Z'),
      ev('2026-11-17T20:00:00.000Z', '2026-11-19T08:00:00.000Z'),
    ]
    const day = dayItems(items, '2026-11-18', tz)
    expect(day.allDay).toEqual([items[0], items[2]])
    expect(day.timed).toEqual([items[1]])
    expect(dayItems(items, '2026-11-19', tz).timed).toEqual([items[2]])
    expect(dayItems(items, '2026-11-20', tz)).toEqual({ allDay: [], timed: [] })
  })

  it('positions timed events by local minutes, clipped to the day, side by side when they overlap', () => {
    const a = ev('2026-11-18T09:00:00.000Z', '2026-11-18T10:00:00.000Z') // 10:00–11:00
    const b = ev('2026-11-18T09:30:00.000Z', '2026-11-18T11:00:00.000Z') // 10:30–12:00
    const c = ev('2026-11-18T11:00:00.000Z', '2026-11-18T11:15:00.000Z') // 12:00–12:15
    const late = ev('2026-11-18T22:00:00.000Z', '2026-11-19T01:00:00.000Z') // 23:00–02:00
    expect(placeTimed([a, b, c, late], '2026-11-18', tz)).toEqual([
      { item: a, top: 600, height: 60, column: 0, columns: 2 },
      { item: b, top: 630, height: 90, column: 1, columns: 2 },
      { item: c, top: 720, height: 15, column: 0, columns: 1 },
      { item: late, top: 1380, height: 60, column: 0, columns: 1 },
    ])
  })
})
