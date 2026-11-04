import { boolean, integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core'

/**
 * Email platform stage 3 (migration 0116): contact lists with subscribe /
 * unsubscribe / double opt-in, and flows (automations) with their enrollments
 * and execution log. Consumed only by modules/email/platform/flows.
 */

export const mailContactLists = pgTable('mail_contact_lists', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  description: text('description'),
  /** New contacts confirm by clicking a link before they count as subscribed. */
  doubleOptIn: boolean('double_opt_in').notNull().default(false),
  /** The public sign-up page /mail/subscribe/<list id> accepts new contacts. */
  publicSignup: boolean('public_signup').notNull().default(false),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const CONTACT_STATUSES = ['pending', 'subscribed', 'unsubscribed'] as const
export type ContactStatus = (typeof CONTACT_STATUSES)[number]
export type UnsubscribeReason = 'UNSUBSCRIBED' | 'BOUNCED' | 'COMPLAINED'

export const mailContacts = pgTable(
  'mail_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    listId: uuid('list_id')
      .notNull()
      .references(() => mailContactLists.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    properties: jsonb('properties').$type<Record<string, string>>().notNull().default({}),
    status: text('status').$type<ContactStatus>().notNull(),
    unsubscribeReason: text('unsubscribe_reason').$type<UnsubscribeReason>(),
    /** Secret for the unsubscribe and confirm links (random, unguessable). */
    token: text('token').notNull().unique(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('mail_contacts_list_email_idx').on(t.listId, t.email)],
)

export const FLOW_STATUSES = ['draft', 'active', 'paused'] as const
export type FlowStatus = (typeof FLOW_STATUSES)[number]

export const mailFlows = pgTable('mail_flows', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  status: text('status').$type<FlowStatus>().notNull().default('draft'),
  /** Trigger: a contact becomes subscribed on this list. */
  triggerListId: uuid('trigger_list_id').references(() => mailContactLists.id, { onDelete: 'set null' }),
  /** The ordered steps (flows/engine.ts FlowStep[]). */
  steps: jsonb('steps').$type<unknown[]>().notNull().default([]),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const mailFlowEnrollments = pgTable(
  'mail_flow_enrollments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    flowId: uuid('flow_id')
      .notNull()
      .references(() => mailFlows.id, { onDelete: 'cascade' }),
    contactId: uuid('contact_id')
      .notNull()
      .references(() => mailContacts.id, { onDelete: 'cascade' }),
    status: text('status').$type<'active' | 'completed' | 'exited'>().notNull().default('active'),
    stepIndex: integer('step_index').notNull().default(0),
    waitUntil: timestamp('wait_until', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [uniqueIndex('mail_flow_enrollments_once_idx').on(t.flowId, t.contactId)],
)

export const FLOW_LOG_EVENTS = ['entered', 'email_sent', 'waiting', 'completed', 'exited', 'error'] as const
export type FlowLogEvent = (typeof FLOW_LOG_EVENTS)[number]

export const mailFlowLog = pgTable('mail_flow_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  flowId: uuid('flow_id')
    .notNull()
    .references(() => mailFlows.id, { onDelete: 'cascade' }),
  enrollmentId: uuid('enrollment_id')
    .notNull()
    .references(() => mailFlowEnrollments.id, { onDelete: 'cascade' }),
  stepId: text('step_id'),
  event: text('event').$type<FlowLogEvent>().notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})
