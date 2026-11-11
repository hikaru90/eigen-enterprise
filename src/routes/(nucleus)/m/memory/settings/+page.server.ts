import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import {
  loadNotificationSettings,
  parseNotificationSettingsBody,
  saveNotificationSettings,
} from '$lib/server/settings/notification-settings'

/** /m/memory: the Memory overview — its sections and Memory's own settings. */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  return { settings: await loadNotificationSettings(event.locals.user.id) }
}

export const actions: Actions = {
  settings: async (event) => {
    if (!event.locals.user) return fail(401, { message: 'Sign in again to save.' })
    const form = await event.request.formData()
    let input
    try {
      input = parseNotificationSettingsBody({
        timezoneOffsetMinutes: Number(form.get('timezoneOffsetMinutes')),
        eventNotificationsEnabled: form.get('eventNotificationsEnabled') === 'on',
        eventReminderLeadMinutes: Number(form.get('eventReminderLeadMinutes')),
        dailySummaryEnabled: form.get('dailySummaryEnabled') === 'on',
        dailySummaryTimeLocal: String(form.get('dailySummaryTimeLocal') ?? ''),
      })
    } catch (e) {
      return fail(400, { message: e instanceof Error ? e.message : String(e) })
    }
    const saved = await saveNotificationSettings(event.locals.user.id, input)
    return { saved: true as const, message: saved.message }
  },
}
