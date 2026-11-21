import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import {
  DELETE_ALL_MEMORIES_CONFIRMATION,
  isDeleteAllMemoriesConfirmation,
} from '$lib/memory/delete-confirmation'
import { errorReport, refusalReport } from '$lib/server/errors/report'
import { deleteAllMemoriesForUser } from '$lib/server/memory/delete-all-memories'
import {
  countArchivedThoughts,
  deleteArchivedThoughtsForUser,
} from '$lib/server/memory/delete-thought'
import {
  loadNotificationSettings,
  parseNotificationSettingsBody,
  saveNotificationSettings,
} from '$lib/server/settings/notification-settings'

/** /m/memory/settings: Memory's own settings and "Your data" (download, delete). */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const userId = event.locals.user.id
  const [settings, archivedCount] = await Promise.all([
    loadNotificationSettings(userId),
    countArchivedThoughts(userId),
  ])
  return { settings, archivedCount, deleteAllConfirmation: DELETE_ALL_MEMORIES_CONFIRMATION }
}

export const actions: Actions = {
  settings: async (event) => {
    const attempted = 'Saving the notification settings on /m/memory/settings'
    if (!event.locals.user) return fail(401, refusalReport('Sign in again to save.', { attempted }))
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
      return fail(
        400,
        errorReport(e, {
          attempted,
          plain: (err) => (err instanceof Error ? err.message : String(err)),
        }),
      )
    }
    const saved = await saveNotificationSettings(event.locals.user.id, input)
    return { saved: true as const, message: saved.message }
  },

  /** Archived thoughts are hidden but stored; this deletes them for good. */
  deleteArchived: async (event) => {
    if (!event.locals.user)
      return fail(401, {
        dataError: refusalReport('Sign in again to delete.', {
          attempted: 'Deleting archived thoughts on /m/memory/settings',
        }),
      })
    const { deleted } = await deleteArchivedThoughtsForUser(event.locals.user.id)
    return { archivedDeleted: deleted }
  },

  /** Everything the person put in Memory, behind a typed confirmation. */
  deleteAll: async (event) => {
    const attempted = 'Deleting everything in Memory on /m/memory/settings'
    if (!event.locals.user)
      return fail(401, { dataError: refusalReport('Sign in again to delete.', { attempted }) })
    const confirmation = String((await event.request.formData()).get('confirmation') ?? '')
    if (!isDeleteAllMemoriesConfirmation(confirmation)) {
      return fail(400, {
        dataError: refusalReport(
          `Type ${DELETE_ALL_MEMORIES_CONFIRMATION} exactly to delete everything.`,
          { attempted },
        ),
      })
    }
    return { deletedAll: await deleteAllMemoriesForUser(event.locals.user.id) }
  },
}
