import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AvailabilityPanel from './availability-panel.svelte'

const members = [
  { id: 'ana', name: 'Ana Lind' },
  { id: 'ben', name: 'Ben Ode' },
]

describe('availability-panel.svelte', () => {
  it('shows each picked colleague’s day: busy, out of office, a company meeting’s title, or free', async () => {
    render(AvailabilityPanel, {
      members,
      selected: ['ana', 'ben'],
      days: ['2026-11-18'],
      timeZone: 'Europe/Berlin',
      hidden: { view: 'day', date: '2026-11-18' },
      people: [
        {
          memberId: 'ana',
          name: 'Ana Lind',
          blocks: [
            { start: '2026-11-18T08:00:00.000Z', end: '2026-11-18T09:00:00.000Z', allDay: false, kind: 'busy', title: 'Team sync' },
            { start: '2026-11-18T10:00:00.000Z', end: '2026-11-18T11:00:00.000Z', allDay: false, kind: 'busy', title: null },
            { start: '2026-11-18T13:00:00.000Z', end: '2026-11-18T14:00:00.000Z', allDay: false, kind: 'out_of_office', title: null },
          ],
        },
        { memberId: 'ben', name: 'Ben Ode', blocks: [] },
      ],
    })
    const ana = page.getByRole('article', { name: 'Ana Lind' })
    const blocks = await ana.getByTestId('availability-block').elements()
    expect(blocks.map((b) => b.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '09:00–10:00 · Team sync',
      '11:00–12:00 · Busy',
      '14:00–15:00 · Out of office',
    ])
    await expect.element(page.getByRole('article', { name: 'Ben Ode' })).toHaveTextContent('Free')
  })

  it('picks people with a plain form that keeps the view and day', async () => {
    render(AvailabilityPanel, { members, selected: ['ben'], days: ['2026-11-18'], timeZone: 'UTC', hidden: { view: 'week', date: '2026-11-18' }, people: [] })
    await expect.element(page.getByRole('checkbox', { name: 'Ben Ode' })).toBeChecked()
    await expect.element(page.getByRole('checkbox', { name: 'Ana Lind' })).not.toBeChecked()
    const form = document.querySelector<HTMLFormElement>('[data-testid="availability-form"]')!
    expect([...new FormData(form).entries()]).toEqual([
      ['view', 'week'],
      ['date', '2026-11-18'],
      ['with', 'ben'],
    ])
  })
})
