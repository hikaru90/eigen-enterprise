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

/**
 * Contact history (migration 0139, Contribute b8a87a25): one row per "Log a
 * contact" — the day, how it went, the follow-up it answered and the one it
 * set. Visible to whoever may see the contact (decided in the service); goes
 * with the contact.
 */
export const contactLogEntries = pgTable(
  'contact_log_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    on: date('on', { mode: 'string' }).notNull(),
    /** How it went, in the person's words. */
    note: text('note'),
    /** The follow-up this contact answered (what was due before it). */
    answeredFollowUpOn: date('answered_follow_up_on', { mode: 'string' }),
    answeredStep: text('answered_step'),
    /** The follow-up it set (none when both are null). */
    nextFollowUpOn: date('next_follow_up_on', { mode: 'string' }),
    nextStep: text('next_step'),
    loggedBy: text('logged_by').notNull(),
    loggedByKind: text('logged_by_kind', { enum: ['user', 'agent'] }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('contact_log_entries_contact_idx').on(t.contactId, t.on.desc(), t.createdAt.desc())],
)
