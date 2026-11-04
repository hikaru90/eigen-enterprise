import { boolean, integer, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * The email platform (plan/phase-polish-1.md P-6; migration 0114 upward): the
 * Owlery feature set inside ee. Company-level tables (single tenant, no RLS).
 * Consumed only by modules/email/platform/store.ts.
 */

/** A sender domain verified at Amazon SES with our own DKIM key (BYO-DKIM). */
export const mailDomains = pgTable('mail_domains', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull().unique(),
  region: text('region').notNull(),
  /** SES VerificationStatus: NOT_STARTED | PENDING | SUCCESS | FAILED | TEMPORARY_FAILURE. */
  status: text('status').notNull().default('NOT_STARTED'),
  dkimSelector: text('dkim_selector').notNull(),
  /** Base64 SPKI public key published as the DKIM TXT record. The private key lives only at Amazon. */
  publicKey: text('public_key').notNull(),
  dkimStatus: text('dkim_status').notNull().default('NOT_STARTED'),
  mailFromStatus: text('mail_from_status').notNull().default('NOT_STARTED'),
  dmarcAdded: boolean('dmarc_added').notNull().default(false),
  /** Open and click tracking for mail from this domain (the tracking configuration set). */
  tracking: boolean('tracking').notNull().default(false),
  errorMessage: text('error_message'),
  /** Still waiting on DNS: the background check keeps re-reading Amazon's status. */
  isVerifying: boolean('is_verifying').notNull().default(true),
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** A named from-address (identity). domainId null = an address Amazon verified on its own. */
export const mailSenders = pgTable('mail_senders', {
  id: uuid('id').primaryKey().defaultRandom(),
  address: text('address').notNull().unique(),
  displayName: text('display_name'),
  domainId: uuid('domain_id').references(() => mailDomains.id, { onDelete: 'cascade' }),
  createdBy: text('created_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const MAIL_SOURCES = ['system', 'agent', 'api', 'test', 'template', 'flow', 'double_opt_in'] as const
export type MailSource = (typeof MAIL_SOURCES)[number]

/** One row per mail the company sends: the sent-mail log. */
export const mailMessages = pgTable('mail_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  sesMessageId: text('ses_message_id').unique(),
  source: text('source').$type<MailSource>().notNull(),
  status: text('status').notNull(),
  fromAddress: text('from_address').notNull(),
  toAddress: text('to_address').notNull(),
  replyTo: text('reply_to'),
  subject: text('subject').notNull(),
  html: text('html'),
  text: text('text'),
  /** False for system mail (sign-in codes): the body never lands in the log. */
  contentStored: boolean('content_stored').notNull(),
  headers: jsonb('headers').$type<{ name: string; value: string }[]>(),
  apiKeyId: uuid('api_key_id'),
  apiKeyName: text('api_key_name'),
  templateId: uuid('template_id'),
  contactId: uuid('contact_id'),
  flowId: uuid('flow_id'),
  scheduledAt: timestamp('scheduled_at', { withTimezone: true }),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** The status timeline of one message (queued → sent → delivered → opened …). */
export const mailMessageEvents = pgTable('mail_message_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  messageId: uuid('message_id')
    .notNull()
    .references(() => mailMessages.id, { onDelete: 'cascade' }),
  status: text('status').notNull(),
  detail: jsonb('detail').$type<Record<string, unknown>>(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).defaultNow().notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

export const SUPPRESSION_REASONS = ['HARD_BOUNCE', 'COMPLAINT', 'MANUAL'] as const
export type SuppressionReason = (typeof SUPPRESSION_REASONS)[number]

/** Addresses the company never mails again (until removed). */
export const mailSuppressions = pgTable('mail_suppressions', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  reason: text('reason').$type<SuppressionReason>().notNull(),
  /** The message id that caused it, or "human:<user id>" for a manual entry. */
  source: text('source'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** The email module's durable background work, drained by the global job-queue tick. */
export const mailJobs = pgTable('mail_jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  dedupeKey: text('dedupe_key'),
  status: text('status').notNull().default('pending'),
  runAt: timestamp('run_at', { withTimezone: true }).defaultNow().notNull(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(5),
  lastError: text('last_error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

