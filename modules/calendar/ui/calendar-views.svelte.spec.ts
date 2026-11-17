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
  onshift: vi.fn(),
})

describe('calendar-views.svelte', () => {
  it('week: the classic grid — seven days side by side, hours down, all-day events on top', async () => {
    await page.viewport(1280, 900)
    const standup = occ('c', 'Standup', '2026-11-18T09:30:00.000Z', '2026-11-18T10:00:00.000Z')
    const p = props('week', [planning, standup, away])
    render(CalendarViews, p)
    await expect.element(page.getByTestId('calendar-week')).toHaveAttribute('data-days', '7')
    const columns = await page.getByTestId('calendar-week-day').elements()
    expect(columns.length).toBe(7)
    // Side by side: every day starts at the same height, each right of the one before.
    const boxes = columns.map((c) => c.getBoundingClientRect())
    for (let i = 1; i < 7; i++) {
      expect(boxes[i].top).toBe(boxes[0].top)
      expect(boxes[i].left).toBeGreaterThan(boxes[i - 1].left)
    }
    const wed = page.getByRole('group', { name: 'Wednesday, 18 November 2026' })
    await expect.element(wed).toHaveTextContent('Planning')
    await expect.element(wed).toHaveTextContent('10:00 – 11:00')
    // Overlapping events share the day's width, side by side.
    await expect.element(wed.getByRole('button', { name: /Planning/ })).toHaveAttribute('style', expect.stringContaining('left: 0%; width: calc(50% - 2px)'))
    await expect.element(wed.getByRole('button', { name: /Standup/ })).toHaveAttribute('style', expect.stringContaining('left: 50%'))
    await expect.element(page.getByRole('list', { name: 'All day on Thursday, 19 November 2026' })).toHaveTextContent('Away')
    await expect.element(page.getByRole('link', { name: 'Wednesday, 18 November 2026' })).toHaveAttribute('aria-current', 'date')

    await wed.getByRole('button', { name: /Planning/ }).click()
    expect(p.onopen).toHaveBeenCalledWith(planning)
    await page.getByRole('button', { name: 'New event on Friday, 20 November 2026', exact: true }).click()
    expect(p.oncreate).toHaveBeenCalledWith('2026-11-20', null)
    await page.getByRole('button', { name: 'New event on Friday, 20 November 2026 at 14:00' }).click()
    expect(p.oncreate).toHaveBeenCalledWith('2026-11-20', '14:00')
  })

  it('week on a phone: three days side by side, paged — never stacked', async () => {
    await page.viewport(375, 800)
    render(CalendarViews, props('week', [planning]))
    await expect.element(page.getByTestId('calendar-week')).toHaveAttribute('data-days', '3')
    const heads = async () => (await page.getByTestId('calendar-week-head').elements()).map((h) => h.textContent?.trim().slice(0, 3))
    expect(await heads()).toEqual(['Mon', 'Tue', 'Wed'])
    await expect.element(page.getByRole('button', { name: 'Earlier days' })).toBeDisabled()
    await page.getByRole('button', { name: 'Later days' }).click()
    expect(await heads()).toEqual(['Thu', 'Fri', 'Sat'])
    await page.getByRole('button', { name: 'Later days' }).click()
    expect(await heads()).toEqual(['Fri', 'Sat', 'Sun'])
    await expect.element(page.getByRole('button', { name: 'Later days' })).toBeDisabled()
  })

  it('a swipe pages through a phone week, then moves to the next or previous week', async () => {
    await page.viewport(375, 800)
    const p = props('week', [])
    render(CalendarViews, { ...p, today: '2026-11-16' })
    const views = (await page.getByTestId('calendar-views').elements())[0]
    const flick = (from: number, to: number) => {
      const at = (type: string, x: number) =>
        views.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: x, clientY: 300, bubbles: true }))
      at('pointerdown', from)
      at('pointermove', (from + to) / 2)
      at('pointerup', to)
    }
    await expect.element(page.getByTestId('calendar-week')).toHaveAttribute('data-days', '3')
    flick(300, 100) // left: later days
    await expect.element(page.getByTestId('calendar-week-head').first()).toHaveTextContent('Thu')
    flick(100, 300) // right: back to the first days
    await expect.element(page.getByTestId('calendar-week-head').first()).toHaveTextContent('Mon')
    expect(p.onshift).not.toHaveBeenCalled()
    flick(100, 300) // right on the first days: the previous week
    expect(p.onshift).toHaveBeenCalledWith(-1)
  })

  it('a swipe in the month or day view moves to the next or previous one; a mouse drag does not', async () => {
    const p = props('month', [])
    render(CalendarViews, p)
    const views = (await page.getByTestId('calendar-views').elements())[0]
    const flick = (pointerType: string) => {
      for (const [type, x] of [['pointerdown', 300], ['pointermove', 200], ['pointerup', 100]] as const) {
        views.dispatchEvent(new PointerEvent(type, { pointerId: 3, pointerType, isPrimary: true, clientX: x, clientY: 200, bubbles: true }))
      }
    }
    flick('mouse')
    expect(p.onshift).not.toHaveBeenCalled()
    flick('touch')
    expect(p.onshift).toHaveBeenCalledWith(1)
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
