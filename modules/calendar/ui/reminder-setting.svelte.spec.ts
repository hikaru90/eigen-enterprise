import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ReminderSetting from './reminder-setting.svelte'

/** What the form would post (the page action reads reminderMinutes). */
function posted(): FormDataEntryValue | null {
  const form = document.querySelector<HTMLFormElement>('[data-testid="calendar-reminder"]')
  if (!form) throw new Error('no reminder form')
  return new FormData(form).get('reminderMinutes')
}

describe('reminder-setting.svelte', () => {
  it('shows the person’s lead and posts the one picked, off included', async () => {
    render(ReminderSetting, { minutes: 10 })
    const select = page.getByRole('combobox', { name: 'Reminder' })
    await expect.element(select).toHaveValue('10')
    expect(posted()).toBe('10')
    await select.selectOptions('When it starts')
    expect(posted()).toBe('0')
    await select.selectOptions('No reminders')
    expect(posted()).toBe('off')
    expect(document.querySelector('[data-testid="calendar-reminder"]')!.getAttribute('action')).toBe('?/reminder')
  })

  it('off shows as off; a refused save shows the reason', async () => {
    render(ReminderSetting, {
      minutes: null,
      error: { error: 'A reminder is 0, 5, 10, 15, 30, 60 minutes before, or off', agent: null },
    })
    await expect.element(page.getByRole('combobox', { name: 'Reminder' })).toHaveValue('off')
    await expect.element(page.getByRole('alert')).toHaveTextContent(/A reminder is/)
  })
})
