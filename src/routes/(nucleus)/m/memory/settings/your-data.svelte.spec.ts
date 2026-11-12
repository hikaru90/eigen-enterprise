import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import SettingsPage from './+page.svelte'

const data = (archivedCount: number) =>
  ({
    settings: {
      timezoneOffsetMinutes: 0,
      eventNotificationsEnabled: true,
      eventReminderLeadMinutes: 15,
      dailySummaryEnabled: false,
      dailySummaryTimeLocal: '08:00',
    },
    archivedCount,
    deleteAllConfirmation: 'DELETE ALL MY MEMORIES',
  }) as never

describe('Memory settings: your data', () => {
  it('arms "Delete everything" only once the exact phrase is typed', async () => {
    render(SettingsPage, { data: data(0), form: null as never })
    const button = page.getByRole('button', { name: 'Delete everything' })
    await expect.element(button).toBeDisabled()
    const input = page.getByLabelText(/to confirm/i)
    await input.fill('delete all my memories')
    await expect.element(button).toBeDisabled()
    await input.fill('DELETE ALL MY MEMORIES')
    await expect.element(button).toBeEnabled()
  })

  it('offers a download and says how many archived thoughts are still stored', async () => {
    render(SettingsPage, { data: data(3), form: null as never })
    await expect
      .element(page.getByRole('link', { name: 'Download' }))
      .toHaveAttribute('href', '/api/memory/export')
    await expect.element(page.getByTestId('memory-archived-count')).toHaveTextContent(/3 hidden/)
    await expect.element(page.getByRole('button', { name: 'Delete archived' })).toBeEnabled()
  })

  it('has nothing to delete when no thought is archived', async () => {
    render(SettingsPage, { data: data(0), form: null as never })
    await expect.element(page.getByRole('button', { name: 'Delete archived' })).toBeDisabled()
  })
})
