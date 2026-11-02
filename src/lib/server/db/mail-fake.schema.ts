import { boolean, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * The fake mail transport (MAIL_TRANSPORT=fake, migration 0104). Test servers
 * only: every mail the app "sends" lands here instead of Amazon SES.
 * Consumed only by modules/email/owlery/fake-store.
 */
export const mailFakeSent = pgTable('mail_fake_sent', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: text('message_id').notNull().unique(),
  fromAddress: text('from_address').notNull(),
  toAddress: text('to_address').notNull(),
  subject: text('subject').notNull(),
  html: text('html').notNull(),
  text: text('text').notNull(),
  replyTo: text('reply_to'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/** The fake's view of SES identities (created = pending until verified through the e2e route). */
export const mailFakeIdentities = pgTable('mail_fake_identities', {
  identity: text('identity').primaryKey(),
  verified: boolean('verified').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
