import { raceWithTimeout } from '$lib/server/async/race-with-timeout'
import { dispatchDueDailySummaries } from '$lib/server/memory/daily-summary-dispatch'
import { dispatchDueEventReminders } from '$lib/server/memory/event-reminder-dispatch'
import { pluginOn } from '$lib/server/plugins/background'

export type NotificationDispatchTickResult = {
  eventReminders: Awaited<ReturnType<typeof dispatchDueEventReminders>>
  dailySummaries: Awaited<ReturnType<typeof dispatchDueDailySummaries>>
}

/** Abort a stuck tick so the in-process guard cannot block the loop for hours. */
export const NOTIFICATION_DISPATCH_TICK_TIMEOUT_MS = 5 * 60 * 1000

let ticking = false

/** A run that dispatched nothing (Memory switched off). */
const NONE = { processed: 0, sent: 0, skipped: 0, failed: 0 }

async function runTickBody(): Promise<NotificationDispatchTickResult> {
  // Reminders and daily summaries are Memory's (its tasks and events): off while Memory is off.
  if (!(await pluginOn('memory', 'event reminders and daily summaries'))) {
    return { eventReminders: { ...NONE }, dailySummaries: { ...NONE } }
  }
  const startedAt = Date.now()
  const [eventReminders, dailySummaries] = await Promise.all([
    dispatchDueEventReminders(),
    dispatchDueDailySummaries(),
  ])

  const hasActivity =
    eventReminders.sent > 0 ||
    eventReminders.failed > 0 ||
    dailySummaries.sent > 0 ||
    dailySummaries.failed > 0

  if (hasActivity) {
    console.info('[notification-dispatch] tick', {
      durationMs: Date.now() - startedAt,
      eventReminders,
      dailySummaries,
    })
  }

  return { eventReminders, dailySummaries }
}

/** Dispatch due event reminders and daily summaries (same work as POST /api/admin/dispatch-reminders). */
export async function tickNotificationDispatch(
  timeoutMs: number = NOTIFICATION_DISPATCH_TICK_TIMEOUT_MS,
): Promise<NotificationDispatchTickResult | null> {
  if (ticking) {
    console.warn('[notification-dispatch] tick skipped — previous tick still running')
    return null
  }

  ticking = true
  try {
    return await raceWithTimeout('notification-dispatch tick', runTickBody, timeoutMs)
  } finally {
    ticking = false
  }
}
