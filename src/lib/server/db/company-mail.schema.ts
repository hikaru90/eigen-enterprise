import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Company email delivery (migration 0087). Consumed only by $lib/server/mail/company-mail. */
export const companyMail = pgTable('company_mail', {
  id: text('id').primaryKey().default('mail'),
  provider: text('provider', { enum: ['owlery'] }).notNull(),
  baseUrl: text('base_url').notNull(),
  emailFrom: text('email_from').notNull(),
  sealedApiKey: text('sealed_api_key').notNull(),
  contactBookId: text('contact_book_id'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
