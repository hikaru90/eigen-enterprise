import type { ReminderDeps } from './service'
import { dbReminderStore } from './db-store'

/**
 * Live wiring: the Postgres store, each call on its own connection scoped to
 * the person under row-level security (withDbUser) — so the dashboard, the
 * reminders page and the assistant acting for the person all read only that
 * person's rows. A new reminder takes the person's time zone from Settings.
 */

let deps: ReminderDeps | null = null

export async function reminderDeps(): Promise<ReminderDeps> {
  if (deps) return deps
  const { withDbUser } = await import('$lib/server/db')
  const { getUserPreferredTimezone } = await import('$lib/server/memory/user-timezone')
  deps = {
    store: dbReminderStore((userId, fn) => withDbUser(userId, fn)),
    timeZoneOf: (userId) => withDbUser(userId, () => getUserPreferredTimezone(userId)),
  }
  return deps
}
