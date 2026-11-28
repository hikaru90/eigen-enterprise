import { pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * The notification inbox's "read" (migration 0192): the items of a person's
 * inbox (src/lib/server/notifications/inbox.ts) they have seen. Company-level
 * (no RLS); the service touches only the signed-in person's rows.
 */
export const notificationReads = pgTable(
  'notification_reads',
  {
    userId: text('user_id').notNull(),
    itemKey: text('item_key').notNull(),
    readAt: timestamp('read_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ name: 'notification_reads_pk', columns: [t.userId, t.itemKey] })],
)
