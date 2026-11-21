import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'

/**
 * Reminders (migration 0163): a person's own recurring reminders — fixed
 * weekdays at a wall time in their time zone. Private to the person (RLS on
 * user_id, enable_rls.sql). Occurrences are computed from the rhythm and
 * `handled_through` (src/lib/server/memory/reminders/service.ts), never stored.
 */
export const reminders = pgTable(
  'reminders',
  {
    id: uuid('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    note: text('note').default('').notNull(),
    /** RFC 5545 weekday codes, Monday first (MO … SU). */
    weekdays: text('weekdays').array().notNull(),
    /** HH:MM wall time in time_zone. */
    time: text('time_of_day').notNull(),
    timeZone: text('time_zone').notNull(),
    status: text('status', { enum: ['active', 'paused'] }).default('active').notNull(),
    /** Every occurrence at or before this instant is handled. */
    handledThrough: timestamp('handled_through', { withTimezone: true }).notNull(),
    snoozedUntil: timestamp('snoozed_until', { withTimezone: true }),
    /** 'assistant' = the person's assistant created it on their word in chat. */
    createdVia: text('created_via', { enum: ['person', 'assistant'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('reminders_user_idx').on(t.userId, t.createdAt)],
)
