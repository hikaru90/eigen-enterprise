import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Website module tables (Phase 1 baseline) — content objects rendered by the
 * public pages under /s/[slug], and captured contact submissions. Not wired
 * into schema.ts; consumed only by modules/website stores.
 */

export const websiteContent = pgTable('website_content', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  kind: text('kind', { enum: ['page', 'doc'] }).notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  visibility: text('visibility', { enum: ['private', 'public'] }).default('private').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const websiteContact = pgTable('website_contact', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name'),
  email: text('email').notNull(),
  message: text('message'),
  source: text('source').default('website').notNull(),
  principalId: text('principal_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
