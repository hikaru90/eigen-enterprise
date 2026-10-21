import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { userApiKey } from './brain.schema'

/** One row per (key, idempotencyKey) sent through POST /api/mail/send (migration 0096). */
export const mailApiSend = pgTable(
  'mail_api_send',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    keyId: uuid('key_id')
      .notNull()
      .references(() => userApiKey.id, { onDelete: 'cascade' }),
    idempotencyKey: text('idempotency_key').notNull(),
    bodyHash: text('body_hash').notNull(),
    recipient: text('recipient').notNull(),
    status: text('status', { enum: ['pending', 'sent'] }).notNull(),
    messageId: text('message_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('mail_api_send_key_idem_idx').on(t.keyId, t.idempotencyKey)],
)
