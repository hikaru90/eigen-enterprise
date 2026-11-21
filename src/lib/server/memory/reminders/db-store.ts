import type { Weekday } from './schedule'
import type { Reminder, ReminderStore } from './store'
import { and, asc, eq } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { reminders } from '$lib/server/db/reminders.schema'

/**
 * Runs `fn` on a connection scoped to the person under row-level security
 * (live: withDbUser). Every store call goes through it, so a row reaches only
 * its owner whatever context the caller runs in — the page, the dashboard, or
 * the assistant acting for the person.
 */
export type AsUser = <T>(userId: string, fn: (db: AppDatabase) => Promise<T>) => Promise<T>

type Row = typeof reminders.$inferSelect

const fromRow = (row: Row): Reminder => ({ ...row, weekdays: row.weekdays as Weekday[] })

/** The Postgres ReminderStore (migration 0163). */
export function dbReminderStore(asUser: AsUser): ReminderStore {
  // The user_id filter repeats the RLS policy: a store never relies on one guard alone.
  const mine = (userId: string, id: string) => and(eq(reminders.userId, userId), eq(reminders.id, id))
  return {
    async insert(reminder) {
      await asUser(reminder.userId, (db) => db.insert(reminders).values(reminder))
    },
    async get(userId, id) {
      const [row] = await asUser(userId, (db) => db.select().from(reminders).where(mine(userId, id)).limit(1))
      return row ? fromRow(row) : null
    },
    async list(userId) {
      const rows = await asUser(userId, (db) =>
        db.select().from(reminders).where(eq(reminders.userId, userId)).orderBy(asc(reminders.createdAt), asc(reminders.id)),
      )
      return rows.map(fromRow)
    },
    async update(userId, id, patch, guard) {
      const where = guard ? and(mine(userId, id), eq(reminders.handledThrough, guard.ifHandledThrough)) : mine(userId, id)
      const [row] = await asUser(userId, (db) => db.update(reminders).set(patch).where(where).returning())
      return row ? fromRow(row) : null
    },
    async delete(userId, id) {
      const rows = await asUser(userId, (db) => db.delete(reminders).where(mine(userId, id)).returning({ id: reminders.id }))
      return rows.length === 1
    },
  }
}
