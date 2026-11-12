import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { LOGO_TYPES } from '$lib/company/identity'

/**
 * The company's identity (migration 0125): one row ('company') with the name
 * set in Settings → Company and the current logo (SHA-256 of the bytes on
 * disk + its type). Company-level table (no RLS): the capability guard
 * decides who may change it (src/lib/server/auth/capabilities.ts).
 */
export const companyProfile = pgTable('company_profile', {
  id: text('id').primaryKey().default('company'),
  name: text('name'),
  logoSha256: text('logo_sha256'),
  logoMime: text('logo_mime', { enum: LOGO_TYPES }),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
