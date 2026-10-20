import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/** Owlery email module settings (migration 0088). Consumed only by modules/email/owlery/store. */
export const owlerySettings = pgTable('owlery_settings', {
  id: text('id').primaryKey().default('owlery'),
  region: text('region').notNull(),
  accessKeyId: text('access_key_id').notNull(),
  sealedSecretAccessKey: text('sealed_secret_access_key').notNull(),
  emailFrom: text('email_from').notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
