import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import type { ReminderView } from '$lib/server/memory/reminders/service'
import Reminders from './reminders.svelte'

const reminder = (over: Partial<ReminderView> = {}): ReminderView => ({
  id: 'r1',
  title: 'LinkedIn posts',
  note: 'Prepare, check or send',
  weekdays: ['MO', 'TH'],
  time: '09:00',
  timeZone: 'Europe/Berlin',
  status: 'active',
  createdVia: 'assistant',
  createdAt: '2026-11-21T12:00:00.000Z',
  nextAt: '2026-11-30T08:00:00.000Z',
  due: null,
  snoozedUntil: null,
  ...over,
})

describe('Memory › Reminders', () => {
  it('offers a new reminder in the person’s zone, and suggests the assistant while there are none', async () => {
    render(Reminders, { reminders: [], timeZone: 'Europe/Berlin' })
    await expect.element(page.getByTestId('reminder-new')).toHaveTextContent(/Times are in Europe\/Berlin/)
    await expect.element(page.getByTestId('new-day-MO')).not.toBeChecked()
    await expect.element(page.getByTestId('reminders-empty')).toHaveTextContent(/ask the assistant/)
  })

  it('shows the rhythm and next time; pause and delete; a paused one offers Resume', async () => {
    render(Reminders, { reminders: [reminder(), reminder({ id: 'r2', title: 'Weekly review', weekdays: ['FR'], status: 'paused', nextAt: null })], timeZone: 'Europe/Berlin' })
    const [first, second] = page.getByTestId('reminder').all()
    await expect.element(first.getByTestId('reminder-rhythm')).toHaveTextContent('Mon, Thu · 09:00 · Europe/Berlin · Next Mon 30 Nov, 09:00')
    await expect.element(first.getByTestId('reminder-pause')).toBeInTheDocument()
    await expect.element(first.getByTestId('reminder-delete')).toBeInTheDocument()
    await expect.element(first.getByTestId('reminder-due')).not.toBeInTheDocument()
    await expect.element(second.getByTestId('reminder-rhythm')).toHaveTextContent('Fri · 09:00 · Europe/Berlin · Paused')
    await expect.element(second.getByTestId('reminder-resume')).toBeInTheDocument()
  })

  it('a due reminder is one row with the oldest open occurrence and the count: Done, all done, snooze', async () => {
    render(Reminders, {
      reminders: [reminder({ due: { oldestAt: '2026-11-23T08:00:00.000Z', latestAt: '2026-11-26T08:00:00.000Z', count: 2 } })],
      timeZone: 'Europe/Berlin',
      formMessage: { reminderId: 'r1', message: 'The reminder changed meanwhile; look again.' },
    })
    await expect.element(page.getByTestId('reminder-due')).toHaveTextContent(/Due since Mon 23 Nov, 09:00 · 2 open/)
    await expect.element(page.getByTestId('reminder-done')).toBeInTheDocument()
    await expect.element(page.getByTestId('reminder-done-all')).toHaveTextContent('All 2 done')
    await expect.element(page.getByTestId('reminder-snooze')).toBeInTheDocument()
    await expect.element(page.getByRole('alert')).toHaveTextContent('The reminder changed meanwhile; look again.')
  })

  it('Edit opens the form with the current weekdays and time; Cancel closes it', async () => {
    render(Reminders, { reminders: [reminder()], timeZone: 'Europe/Berlin' })
    await page.getByTestId('reminder-edit-open').click()
    await expect.element(page.getByTestId('edit-r1-day-MO')).toBeChecked()
    await expect.element(page.getByTestId('edit-r1-day-TU')).not.toBeChecked()
    await expect.element(page.getByTestId('edit-r1-day-TH')).toBeChecked()
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(page.getByTestId('reminder-edit')).not.toBeInTheDocument()
  })
})
