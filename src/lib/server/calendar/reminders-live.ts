import type { ReminderPush } from '../../../../modules/calendar/reminders'

/**
 * Calendar reminders on the phone (plan/calendar.md K3): the live push for
 * the reminder tick. Each person's reminder is written in their own language
 * (Settings' UI language) with times in their own zone, and delivered to
 * their devices with notifications on (read in their own scope, like every
 * push to a person). An event with a call opens the call.
 */

async function readerOf(memberId: string): Promise<{ locale: 'en' | 'de'; timeZone: string }> {
  const { eq } = await import('drizzle-orm')
  const { getDb, withDbUser } = await import('$lib/server/db')
  const { userPreference } = await import('$lib/server/db/schema')
  const { normalizeUiLocale } = await import('$lib/i18n/ui-locale')
  const { getUserPreferredTimezone } = await import('$lib/server/memory/user-timezone')
  return withDbUser(memberId, async () => {
    const [pref] = await getDb()
      .select({ uiLocale: userPreference.preferredUiLocale })
      .from(userPreference)
      .where(eq(userPreference.userId, memberId))
      .limit(1)
    return { locale: normalizeUiLocale(pref?.uiLocale ?? 'en'), timeZone: await getUserPreferredTimezone(memberId) }
  })
}

export const liveReminderPush: ReminderPush = async (memberId, reminder) => {
  const { reminderNotification } = await import('../../../../modules/calendar/reminders')
  const { pushToPerson } = await import('$lib/server/push/person')
  const payload = reminderNotification(reminder, await readerOf(memberId))
  const out = await pushToPerson(memberId, payload)
  if (out === null) return 'no_device'
  if (out.sent === 0) throw new Error(`no device took the reminder (${out.failed} failed, ${out.removed} gone): ${out.errors.join('; ')}`)
  return 'sent'
}

/** One pass: send every calendar reminder that is due now. */
export async function sendCalendarReminders(now: Date = new Date()) {
  const { calendarDeps } = await import('../../../../modules/calendar/live')
  const { sendDueReminders } = await import('../../../../modules/calendar/reminders')
  return sendDueReminders(await calendarDeps(), liveReminderPush, now, {
    onError: (err, r) =>
      console.error('[calendar] reminder push failed (retried next tick)', {
        eventId: r.eventId,
        memberId: r.memberId,
        message: err instanceof Error ? err.message : String(err),
      }),
  })
}
