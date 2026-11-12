import { sql } from 'drizzle-orm'
import { boolean, date, index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Contacts (migration 0124, plan/contribute-round-3.md W1): the people the
 * company knows. A company-level table (no RLS), like Drive and Contribute:
 * who may see a contact is decided in the contacts service
 * (modules/contacts/service.ts) — private to its creator plus the owner and
 * admins, or shared with the company.
 */
export const contacts = pgTable(
  'contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    organisation: text('organisation'),
    /** Role or job title. */
    title: text('title'),
    /** [{ type: email|phone|linkedin|website|other, value }] — validated by the service. */
    channels: jsonb('channels').$type<Array<{ type: string; value: string }>>().notNull().default(sql`'[]'::jsonb`),
    /** Where or how you met. */
    metHow: text('met_how'),
    whyRelevant: text('why_relevant'),
    /** Lower-case tags: partner, customer, funder, investor, production, or the creator's own. */
    tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
    lastContactedOn: date('last_contacted_on', { mode: 'string' }),
    nextFollowUpOn: date('next_follow_up_on', { mode: 'string' }),
    nextStep: text('next_step'),
    /** A person's user id, or the agent's principal id (created_by_kind = 'agent'). */
    createdBy: text('created_by').notNull(),
    createdByKind: text('created_by_kind', { enum: ['user', 'agent'] }).notNull(),
    /** false = private to its creator (plus the owner and admins). */
    shared: boolean('shared').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('contacts_created_by_idx').on(t.createdBy),
    index('contacts_next_follow_up_idx').on(t.nextFollowUpOn).where(sql`${t.nextFollowUpOn} IS NOT NULL`),
    index('contacts_tags_idx').using('gin', t.tags),
  ],
)
