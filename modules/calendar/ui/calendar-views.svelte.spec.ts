import type { OccurrenceDto } from '../types'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
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
    expect(await page.getByRole('rowheader').elements()).toHaveLength(0)
  })

  it('month with week numbers: each week starts with its ISO week', async () => {
    render(CalendarViews, { ...props('month', []), weekNumbers: true })
    const weeks = await page.getByRole('rowheader').elements()
    expect(weeks.map((w) => w.textContent?.trim())).toEqual(['44', '45', '46', '47', '48', '49'])
    await expect.element(page.getByRole('rowheader', { name: 'Week 47' })).toBeVisible()
    expect((await page.getByRole('gridcell').elements()).length).toBe(42)
  })
})

describe('calendar-views.svelte: resizable days in the week', () => {
  const KEY = 'test.week-columns'
  const widthOf = async (name: string) => (await page.getByRole('group', { name }).element()).getBoundingClientRect().width
  const MON = 'Monday, 16 November 2026'
  const TUE = 'Tuesday, 17 November 2026'

  it('arrow keys on a day’s edge widen or narrow it, the others share the rest; Home makes them equal again', async () => {
    localStorage.removeItem(KEY)
    await page.viewport(1280, 900)
    render(CalendarViews, { ...props('week', [planning]), columnsKey: KEY })
    const edge = page.getByRole('separator', { name: 'Resize Monday' })
    await expect.element(edge).toHaveAttribute('aria-valuenow', '14')
    expect(Math.abs((await widthOf(MON)) - (await widthOf(TUE)))).toBeLessThan(1)
    await expect.element(page.getByRole('button', { name: 'Reset column widths' })).not.toBeInTheDocument()

    ;((await edge.element()) as HTMLElement).focus()
    await userEvent.keyboard('{ArrowRight}{ArrowRight}{ArrowRight}')
    await expect.element(edge).toHaveAttribute('aria-valuenow', '20')
    expect(await widthOf(MON)).toBeGreaterThan((await widthOf(TUE)) * 1.3)
    expect(JSON.parse(localStorage.getItem(KEY)!)[0]).toBeCloseTo(20.29, 1)
    // The event still fills its day, whatever the widths.
    await expect.element(page.getByRole('group', { name: 'Wednesday, 18 November 2026' }).getByRole('button', { name: /Planning/ })).toBeVisible()

    await userEvent.keyboard('{Home}')
    await expect.element(edge).toHaveAttribute('aria-valuenow', '14')
    expect(localStorage.getItem(KEY)).toBeNull()
  })

  it('remembers the widths in this browser; “Reset column widths” or a double-click makes them equal', async () => {
    const wide = [40, 10, 10, 10, 10, 10, 10]
    localStorage.setItem(KEY, JSON.stringify(wide))
    await page.viewport(1280, 900)
    render(CalendarViews, { ...props('week', []), columnsKey: KEY })
    await expect.element(page.getByRole('separator', { name: 'Resize Monday' })).toHaveAttribute('aria-valuenow', '40')
    expect(await widthOf(MON)).toBeGreaterThan((await widthOf(TUE)) * 3.5)
    await page.getByRole('button', { name: 'Reset column widths' }).click()
    await expect.element(page.getByRole('separator', { name: 'Resize Monday' })).toHaveAttribute('aria-valuenow', '14')
    expect(localStorage.getItem(KEY)).toBeNull()

    localStorage.setItem(KEY, JSON.stringify(wide))
    render(CalendarViews, { ...props('week', []), columnsKey: KEY })
    const edge = page.getByRole('separator', { name: 'Resize Monday' }).last()
    await expect.element(edge).toHaveAttribute('aria-valuenow', '40')
    // (Component specs run without Tailwind, so the thin edge has no box to point at.)
    ;(await edge.element()).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await expect.element(edge).toHaveAttribute('aria-valuenow', '14')
    localStorage.removeItem(KEY)
  })

  it('dragging a day’s edge with the pointer sets its width', async () => {
    localStorage.removeItem(KEY)
    await page.viewport(1280, 900)
    render(CalendarViews, { ...props('week', []), columnsKey: KEY })
    const edge = (await page.getByRole('separator', { name: 'Resize Monday' }).element()) as HTMLElement
    const x = edge.getBoundingClientRect().left
    const at = (type: string, clientX: number) => edge.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'mouse', clientX, clientY: 20, bubbles: true }))
    at('pointerdown', x)
    at('pointermove', x + 100)
    at('pointerup', x + 100)
    expect(await widthOf(MON)).toBeGreaterThan((await widthOf(TUE)) + 80)
    expect(JSON.parse(localStorage.getItem(KEY)!)).toHaveLength(7)
    localStorage.removeItem(KEY)
  })

  it('not on a phone: three equal days, no edges to drag', async () => {
    localStorage.setItem(KEY, JSON.stringify([40, 10, 10, 10, 10, 10, 10]))
    await page.viewport(375, 800)
    render(CalendarViews, { ...props('week', []), columnsKey: KEY })
    await expect.element(page.getByTestId('calendar-week')).toHaveAttribute('data-days', '3')
    expect(await page.getByRole('separator').elements()).toHaveLength(0)
    expect(Math.abs((await widthOf(MON)) - (await widthOf(TUE)))).toBeLessThan(1)
    localStorage.removeItem(KEY)
  })
})
