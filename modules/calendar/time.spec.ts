import { describe, expect, it } from 'vitest'
import { isTimeZone, localOf, localSpan, parseDay, parseWall, wallToInstant } from './time'

describe('wall time ↔ instant', () => {
  it('knows real zones, days and wall times only', () => {
    expect(isTimeZone('Europe/Berlin')).toBe(true)
    expect(isTimeZone('Mars/Olympus')).toBe(false)
    expect(isTimeZone(' UTC')).toBe(false)
    expect(parseDay('2026-02-29')).toBeNull()
    expect(parseDay('2028-02-29')?.toString()).toBe('2028-02-29')
    expect(parseWall('2026-11-16T24:00')).toBeNull()
    expect(parseWall('2026-11-16 10:00')).toBeNull()
  })

  it('an hour skipped when clocks go forward moves forward; one that exists twice takes the first', () => {
    expect(wallToInstant(parseWall('2026-03-29T02:30')!, 'Europe/Berlin').toISOString()).toBe('2026-03-29T01:30:00.000Z')
    expect(wallToInstant(parseWall('2026-10-25T02:30')!, 'Europe/Berlin').toISOString()).toBe('2026-10-25T00:30:00.000Z')
  })

  it('reads back local days and times; an all-day span ends on its last day', () => {
    expect(localOf('2026-11-16T09:00:00Z', 'Europe/Berlin')).toEqual({ day: '2026-11-16', time: '10:00' })
    expect(localSpan('2026-11-18T23:00:00Z', '2026-11-20T23:00:00Z', 'Europe/Berlin', true)).toEqual({ start: '2026-11-19', end: '2026-11-20' })
    expect(localSpan('2026-11-16T09:00:00Z', '2026-11-16T10:00:00Z', 'Europe/Berlin', false)).toEqual({ start: '2026-11-16T10:00', end: '2026-11-16T11:00' })
  })
})
