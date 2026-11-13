import { sql } from 'drizzle-orm'
import { boolean, index, pgTable, text, timestamp, uniqueIndex, uuid, type AnyPgColumn } from 'drizzle-orm/pg-core'

/**
 * Calendar (migration 0136, plan/calendar.md K1). Company-level tables (no
 * RLS), like contacts: who sees what is decided in the calendar service
 * (modules/calendar/service.ts).
 */
export const calendarEvents = pgTable(
  'calendar_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /** The member whose calendar this is. */
    ownerId: text('owner_id').notNull(),
    title: text('title').notNull(),
    notes: text('notes'),
    /** UTC instants; an all-day event runs from midnight of its first day to midnight after its last (in time_zone). */
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    /** IANA zone it was made in (recurrences expand in it). */
    timeZone: text('time_zone').notNull(),
    allDay: boolean('all_day').notNull().default(false),
    location: text('location'),
    /** A Calls meeting id (K3). */
    callId: text('call_id'),
    visibility: text('visibility', { enum: ['company', 'busy', 'private'] }).notNull().default('busy'),
    status: text('status', { enum: ['confirmed', 'tentative', 'cancelled'] }).notNull().default('confirmed'),
    source: text('source', { enum: ['local', 'google', 'microsoft', 'email_proposal'] }).notNull().default('local'),
    externalId: text('external_id'),
    etag: text('etag'),
    /** RRULE (without the "RRULE:" prefix) of a series; null for a single event or an override. */
    rrule: text('rrule'),
    /** Instance starts removed from the series. */
    exdates: timestamp('exdates', { withTimezone: true }).array().notNull().default(sql`'{}'::timestamptz[]`),
    /** End of the series' last instance (null = no end): lets range reads skip finished series. */
    recurrenceEndsAt: timestamp('recurrence_ends_at', { withTimezone: true }),
    /** An override: the series it belongs to, and the instance start it replaces. */
    recurrenceId: uuid('recurrence_id').references((): AnyPgColumn => calendarEvents.id, { onDelete: 'cascade' }),
    originalStart: timestamp('original_start', { withTimezone: true }),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    index('calendar_events_owner_start_idx').on(t.ownerId, t.startsAt),
    index('calendar_events_recurrence_idx').on(t.recurrenceId).where(sql`${t.recurrenceId} IS NOT NULL`),
    uniqueIndex('calendar_events_override_uniq').on(t.recurrenceId, t.originalStart).where(sql`${t.recurrenceId} IS NOT NULL`),
    uniqueIndex('calendar_events_external_uniq').on(t.ownerId, t.source, t.externalId).where(sql`${t.externalId} IS NOT NULL`),
  ],
)

/** Who is invited: a member (member_id) or someone outside the company (email). */
export const calendarAttendees = pgTable(
  'calendar_attendees',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    eventId: uuid('event_id')
      .notNull()
      .references(() => calendarEvents.id, { onDelete: 'cascade' }),
    memberId: text('member_id'),
    /** Lower case. */
    email: text('email'),
    name: text('name'),
    role: text('role', { enum: ['required', 'optional'] }).notNull().default('required'),
    rsvp: text('rsvp', { enum: ['needs_action', 'accepted', 'declined', 'tentative'] }).notNull().default('needs_action'),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    uniqueIndex('calendar_attendees_member_uniq').on(t.eventId, t.memberId).where(sql`${t.memberId} IS NOT NULL`),
    uniqueIndex('calendar_attendees_email_uniq').on(t.eventId, t.email).where(sql`${t.email} IS NOT NULL`),
    index('calendar_attendees_member_idx').on(t.memberId).where(sql`${t.memberId} IS NOT NULL`),
  ],
)

/** A member's calendar settings: what colleagues see of a new event by default. */
export const calendarPreferences = pgTable('calendar_preferences', {
  memberId: text('member_id').primaryKey(),
  defaultVisibility: text('default_visibility', { enum: ['company', 'busy', 'private'] }).notNull().default('busy'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
