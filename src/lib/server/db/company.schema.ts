import { doublePrecision, pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { CROPPABLE_LOGO_TYPES, LOGO_TYPES } from '$lib/company/identity'

/**
 * The company's identity (migration 0125): one row ('company') with the name
 * set in Settings → Company and the current logo (SHA-256 of the bytes on
 * disk + its type). Company-level table (no RLS): the capability guard
 * decides who may change it (src/lib/server/auth/capabilities.ts).
 *
 * A cropped raster logo (migration 0144) also names the original it was cut
 * from and the crop (a square in the original's pixels), so it can be
 * cropped again; all five are null for an SVG or a logo from before 0144.
 */
export const companyProfile = pgTable('company_profile', {
  id: text('id').primaryKey().default('company'),
  name: text('name'),
  logoSha256: text('logo_sha256'),
  logoMime: text('logo_mime', { enum: LOGO_TYPES }),
  logoOriginalSha256: text('logo_original_sha256'),
  logoOriginalMime: text('logo_original_mime', { enum: CROPPABLE_LOGO_TYPES }),
  logoCropLeft: doublePrecision('logo_crop_left'),
  logoCropTop: doublePrecision('logo_crop_top'),
  logoCropSize: doublePrecision('logo_crop_size'),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
