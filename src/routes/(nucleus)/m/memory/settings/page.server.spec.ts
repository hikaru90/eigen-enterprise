import { describe, expect, it, vi } from 'vitest'

const { loadSettings, parseBody, saveSettings } = vi.hoisted(() => ({
  loadSettings: vi.fn(async (_userId: string) => ({
    timezoneOffsetMinutes: 60,
    eventNotificationsEnabled: true,
    eventReminderLeadMinutes: 15,
    dailySummaryEnabled: false,
    dailySummaryTimeLocal: '08:00',
  })),
  parseBody: vi.fn(),
  saveSettings: vi.fn(),
}))

vi.mock('$lib/server/settings/notification-settings', () => ({
  loadNotificationSettings: loadSettings,
  parseNotificationSettingsBody: parseBody,
  saveNotificationSettings: saveSettings,
}))

const { load, actions } = await import('./+page.server')

const signedIn = { locals: { user: { id: 'u1' } } }

describe('/m/memory/settings page', () => {
  it("loads Memory's own settings (reminders, daily summary, timezone)", async () => {
    const data = (await load(signedIn as never)) as {
      settings: { eventReminderLeadMinutes: number }
    }
    expect(loadSettings).toHaveBeenCalledWith('u1')
    expect(data.settings.eventReminderLeadMinutes).toBe(15)
  })

  it('saves settings from the form', async () => {
    const parsed = {
      timezoneOffsetMinutes: 0,
      eventNotificationsEnabled: true,
      eventReminderLeadMinutes: 30,
      dailySummaryEnabled: true,
      dailySummaryTimeLocal: '07:30',
    }
    parseBody.mockReturnValueOnce(parsed)
    saveSettings.mockResolvedValueOnce({ ...parsed, message: 'Notification settings saved.' })
    const form = new FormData()
    form.set('timezoneOffsetMinutes', '0')
    form.set('eventNotificationsEnabled', 'on')
    form.set('eventReminderLeadMinutes', '30')
    form.set('dailySummaryEnabled', 'on')
    form.set('dailySummaryTimeLocal', '07:30')
    const result = await actions.settings({
      ...signedIn,
      request: { formData: async () => form },
    } as never)
    expect(parseBody).toHaveBeenCalledWith({
      timezoneOffsetMinutes: 0,
      eventNotificationsEnabled: true,
      eventReminderLeadMinutes: 30,
      dailySummaryEnabled: true,
      dailySummaryTimeLocal: '07:30',
    })
    expect(saveSettings).toHaveBeenCalledWith('u1', parsed)
    expect(result).toEqual({ saved: true, message: 'Notification settings saved.' })
  })

  it('returns a 400 with the plain-words reason for invalid input', async () => {
    parseBody.mockImplementationOnce(() => {
      throw new Error('Reminder lead time must be at least 1 minute.')
    })
    const form = new FormData()
    form.set('eventReminderLeadMinutes', '0')
    const result = await actions.settings({
      ...signedIn,
      request: { formData: async () => form },
    } as never)
    expect(result).toMatchObject({
      status: 400,
      data: { message: 'Reminder lead time must be at least 1 minute.' },
    })
  })

  it('refuses a signed-out save', async () => {
    const result = await actions.settings({ locals: { user: null } } as never)
    expect(result).toMatchObject({ status: 401 })
  })
})
