import type { OccurrenceDto } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import CalendarViews from './calendar-views.svelte'
import { viewDays } from './layout'

const occ = (key: string, title: string, start: string, end: string, over: Partial<OccurrenceDto> = {}): OccurrenceDto => ({
  key,
  start,
  end,
  allDay: false,
  ownerId: 'ana',
  ownerName: 'Ana Lind',
  view: 'full',
  title,
  status: 'confirmed',
  occurrenceStart: null,
  event: null,
  ...over,
})

const planning = occ('a', 'Planning', '2026-11-18T09:00:00.000Z', '2026-11-18T10:00:00.000Z')
const away = occ('b', 'Away', '2026-11-18T23:00:00.000Z', '2026-11-20T23:00:00.000Z', { allDay: true })
const props = (view: 'day' | 'week' | 'month', occurrences: OccurrenceDto[]) => ({
  view,
  days: viewDays(view, '2026-11-18'),
  month: '2026-11',
  today: '2026-11-18',
  timeZone: 'Europe/Berlin',
  occurrences,
  dayHref: (day: string) => `/m/calendar?view=day&date=${day}`,
  onopen: vi.fn(),
  oncreate: vi.fn(),
})

describe('calendar-views.svelte', () => {
  it('week: each day with its events in local time; an empty day says so; tapping opens or adds', async () => {
    const p = props('week', [planning, away])
    render(CalendarViews, p)
    const wed = page.getByRole('listitem', { name: 'Wednesday, 18 November 2026' })
    await expect.element(wed).toHaveTextContent('10:00 – 11:00')
    await expect.element(wed).toHaveTextContent('Today')
    await expect.element(page.getByRole('listitem', { name: 'Thursday, 19 November 2026' })).toHaveTextContent('All day')
    await expect.element(page.getByRole('listitem', { name: 'Monday, 16 November 2026' })).toHaveTextContent('Nothing planned')
    await page.getByRole('button', { name: /Planning/ }).click()
    expect(p.onopen).toHaveBeenCalledWith(planning)
    await page.getByRole('button', { name: 'New event on Friday, 20 November 2026' }).click()
    expect(p.oncreate).toHaveBeenCalledWith('2026-11-20', null)
  })

  it('day: an hour grid; an empty hour starts a new event there', async () => {
    const p = props('day', [planning])
    render(CalendarViews, p)
    await expect.element(page.getByTestId('calendar-event')).toHaveTextContent('Planning')
    await page.getByRole('button', { name: 'New event at 14:00' }).click()
    expect(p.oncreate).toHaveBeenCalledWith('2026-11-18', '14:00')
  })

  it('month: six weeks, days link to their day view, at most three events a day', async () => {
    const many = [1, 2, 3, 4].map((i) => occ(`m${i}`, `Meeting ${i}`, `2026-11-18T0${i}:00:00.000Z`, `2026-11-18T0${i}:30:00.000Z`))
    render(CalendarViews, props('month', many))
    expect((await page.getByRole('gridcell').elements()).length).toBe(42)
    const cell = page.getByRole('gridcell', { name: 'Wednesday, 18 November 2026' })
    await expect.element(cell).toHaveTextContent('+1 more')
    expect((await cell.getByTestId('calendar-event').elements()).length).toBe(3)
    await expect.element(cell.getByRole('link', { name: '18' })).toHaveAttribute('href', '/m/calendar?view=day&date=2026-11-18')
  })
})
