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

const { countArchived, deleteArchived, deleteAll } = vi.hoisted(() => ({
  countArchived: vi.fn(async (_userId: string) => 4),
  deleteArchived: vi.fn(),
  deleteAll: vi.fn(),
}))

vi.mock('$lib/server/memory/delete-thought', () => ({
  countArchivedThoughts: countArchived,
  deleteArchivedThoughtsForUser: deleteArchived,
}))

vi.mock('$lib/server/memory/delete-all-memories', () => ({ deleteAllMemoriesForUser: deleteAll }))

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

  it('counts the archived thoughts that are hidden but still stored', async () => {
    const data = (await load(signedIn as never)) as { archivedCount: number }
    expect(countArchived).toHaveBeenCalledWith('u1')
    expect(data.archivedCount).toBe(4)
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

describe('/m/memory/settings: your data', () => {
  const post = (action: 'deleteAll' | 'deleteArchived', fields: Record<string, string>) => {
    const form = new FormData()
    for (const [k, v] of Object.entries(fields)) form.set(k, v)
    return actions[action]({ ...signedIn, request: { formData: async () => form } } as never)
  }

  it('deletes everything only with the exact typed confirmation', async () => {
    expect(await post('deleteAll', { confirmation: 'delete' })).toMatchObject({
      status: 400,
      data: { dataMessage: expect.stringContaining('DELETE ALL MY MEMORIES') },
    })
    expect(deleteAll).not.toHaveBeenCalled()

    deleteAll.mockResolvedValueOnce({ thoughtsDeleted: 12, entitiesDeleted: 3, notesDeleted: 2 })
    expect(await post('deleteAll', { confirmation: 'DELETE ALL MY MEMORIES' })).toEqual({
      deletedAll: { thoughtsDeleted: 12, entitiesDeleted: 3, notesDeleted: 2 },
    })
    expect(deleteAll).toHaveBeenCalledWith('u1')
  })

  it('deletes the archived thoughts for good', async () => {
    deleteArchived.mockResolvedValueOnce({ deleted: 4 })
    expect(await post('deleteArchived', {})).toEqual({ archivedDeleted: 4 })
    expect(deleteArchived).toHaveBeenCalledWith('u1')
  })

  it('refuses signed-out deletes', async () => {
    for (const action of ['deleteAll', 'deleteArchived'] as const) {
      expect(await actions[action]({ locals: { user: null } } as never)).toMatchObject({
        status: 401,
      })
    }
  })
})
