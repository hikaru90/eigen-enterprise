import { sql } from 'drizzle-orm'
import { boolean, check, date, index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { user } from './auth.schema'
import { memberGroup } from './team.schema'

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
    /**
     * The pipeline list it sits in (migration 0144, Contribute 8c6a0cb7), GTD-style and set by a person or an
     * explicit tool call — never inferred: inbox (not contacted yet), next (ours to act), waiting (on their
     * reply, since waiting_since), keep_in_touch (next_follow_up_on is the tickler).
     */
    stage: text('stage', { enum: ['inbox', 'next', 'waiting', 'keep_in_touch'] }).notNull().default('inbox'),
    /** Who on our side holds the contact: a company member's user id. */
    ownerId: text('owner_id'),
    /** How we are in touch: email, phone, linkedin, meeting, message, other. */
    via: text('via', { enum: ['email', 'phone', 'linkedin', 'meeting', 'message', 'other'] }),
    /** Where things stand, in a line. */
    latestStatus: text('latest_status'),
    /** Waiting for their reply since this day (set exactly while stage = waiting). */
    waitingSince: date('waiting_since', { mode: 'string' }),
    /** A person's user id, or the agent's principal id (created_by_kind = 'agent'). */
    createdBy: text('created_by').notNull(),
    createdByKind: text('created_by_kind', { enum: ['user', 'agent'] }).notNull(),
    /**
     * Shared with the whole team: every member of the company, now and later (read time, migration 0150).
     * false = private to its creator (plus the owner and admins) and whoever contact_shares names.
     */
    shared: boolean('shared').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('contacts_created_by_idx').on(t.createdBy),
    index('contacts_next_follow_up_idx').on(t.nextFollowUpOn).where(sql`${t.nextFollowUpOn} IS NOT NULL`),
    index('contacts_tags_idx').using('gin', t.tags),
    index('contacts_stage_idx').on(t.stage),
  ],
)

/**
 * Contacts "Next up" (migration 0145, Contribute 057ebd74): the assistant's
 * last pick of who to write to next, one row per person — a cache, so the
 * Contacts page doesn't ask the AI on every visit. The picks
 * ([{ contactId, kind, reason }]) are validated by the service on read.
 */
export const contactNextUp = pgTable('contact_next_up', {
  userId: text('user_id').primaryKey(),
  /** The person's day it was made for (a new day is a new pick). */
  day: date('day', { mode: 'string' }).notNull(),
  generatedAt: timestamp('generated_at', { withTimezone: true }).notNull(),
  suggestions: jsonb('suggestions').$type<unknown>().notNull().default(sql`'[]'::jsonb`),
})

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

/**
 * A contact shared with one person or one group (migration 0150, Contribute
 * 9d28020a). A group share follows the group's membership when contacts are
 * read. Removing a member or deleting a group drops their shares (cascade).
 */
export const contactShares = pgTable(
  'contact_shares',
  {
    contactId: uuid('contact_id')
      .notNull()
      .references(() => contacts.id, { onDelete: 'cascade' }),
    subjectKind: text('subject_kind', { enum: ['user', 'group'] }).notNull(),
    userId: text('user_id').references(() => user.id, { onDelete: 'cascade' }),
    groupId: text('group_id').references(() => memberGroup.id, { onDelete: 'cascade' }),
    grantedBy: text('granted_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('contact_shares_subject_unique').on(t.contactId, t.subjectKind, sql`coalesce(${t.userId}, ${t.groupId})`),
    index('contact_shares_user_idx')
      .on(t.userId)
      .where(sql`${t.userId} IS NOT NULL`),
    index('contact_shares_group_idx')
      .on(t.groupId)
      .where(sql`${t.groupId} IS NOT NULL`),
    check(
      'contact_shares_subject_shape',
      sql`(${t.subjectKind} = 'user' AND ${t.userId} IS NOT NULL AND ${t.groupId} IS NULL)
        OR (${t.subjectKind} = 'group' AND ${t.groupId} IS NOT NULL AND ${t.userId} IS NULL)`,
    ),
  ],
)

/** A person's own default for new contacts (migration 0150); no row = follow the company's. */
export const contactPreferences = pgTable('contact_preferences', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  defaultVisibility: text('default_visibility', { enum: ['private', 'team'] }).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** The company-wide default for new contacts (migration 0150): one row (id = true); no row = private. */
export const contactCompanySettings = pgTable('contact_company_settings', {
  id: boolean('id').primaryKey().default(true),
  defaultVisibility: text('default_visibility', { enum: ['private', 'team'] }).notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
