/**
 * Calendar reminders on the global job-queue tick (plan/calendar.md K3):
 * every minute, the pushes due before people's events go out (each once).
 * A failure is logged loudly and never stops the rest of the tick; the next
 * pass retries.
 */
export async function tickCalendarReminders(): Promise<void> {
  try {
    const { sendCalendarReminders } = await import('$lib/server/calendar/reminders-live')
    const out = await sendCalendarReminders()
    if (out.sent > 0 || out.failed > 0) console.info('[calendar] reminders', out)
  } catch (err) {
    console.error('[calendar] reminder tick failed', { message: err instanceof Error ? err.message : String(err) })
  }
}
