import type { InboxDeps } from './inbox'
import { and, eq, inArray } from 'drizzle-orm'
import { notificationReads } from '$lib/server/db/notification-reads.schema'

/** The Postgres read marks of the notification inbox (migration 0192), over the app pool. */
export async function dbNotificationReads(): Promise<InboxDeps['reads']> {
  const { appSql, createScopedDrizzle } = await import('$lib/server/db')
  const db = createScopedDrizzle(appSql)
  return {
    async readKeys(userId, keys) {
      const rows = await db
        .select({ key: notificationReads.itemKey })
        .from(notificationReads)
        .where(and(eq(notificationReads.userId, userId), inArray(notificationReads.itemKey, keys)))
      return new Set(rows.map((r) => r.key))
    },
    async markRead(userId, keys, at) {
      await db
        .insert(notificationReads)
        .values(keys.map((itemKey) => ({ userId, itemKey, readAt: at })))
        .onConflictDoNothing()
    },
  }
}
