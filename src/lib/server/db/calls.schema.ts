import { primaryKey, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Calls (migration 0122). Company-level tables (no RLS): access is decided in
 * the calls service (modules/calls/service.ts). The partial unique index
 * call_live_context_idx (one live call per DM/channel) lives in the SQL.
 */

export const calls = pgTable('call', {
  id: uuid('id').primaryKey().defaultRandom(),
  roomName: text('room_name').notNull().unique('call_room_name_unique'),
  contextKind: text('context_kind', { enum: ['dm', 'channel', 'meeting'] }).notNull(),
  contextId: text('context_id'),
  title: text('title').notNull(),
  startedBy: text('started_by').notNull(),
  state: text('state', { enum: ['ringing', 'active', 'ended', 'missed', 'declined'] })
    .default('ringing')
    .notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }).defaultNow().notNull(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
})

export const callParticipants = pgTable(
  'call_participant',
  {
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    invitedAt: timestamp('invited_at', { withTimezone: true }).defaultNow().notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),
    response: text('response', { enum: ['accepted', 'declined', 'none'] })
      .default('none')
      .notNull(),
  },
  (t) => [primaryKey({ columns: [t.callId, t.userId], name: 'call_participant_pk' })],
)
