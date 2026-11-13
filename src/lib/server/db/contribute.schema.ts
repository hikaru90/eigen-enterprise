import { boolean, date, integer, pgTable, primaryKey, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * Contribute (migration 0121). Company-level tables (no RLS): access is
 * decided in the contribute service (modules/contribute/service.ts).
 */

export const contributions = pgTable('contributions', {
  id: uuid('id').primaryKey().defaultRandom(),
  title: text('title').notNull(),
  kind: text('kind', { enum: ['idea', 'bug', 'polish'] }).notNull(),
  area: text('area', {
    enum: ['dashboard', 'assistant', 'messages', 'website', 'email', 'brand', 'memory', 'drive', 'settings', 'contribute', 'everywhere'],
  }).notNull(),
  status: text('status', { enum: ['requested', 'in_progress', 'shipped', 'declined'] })
    .default('requested')
    .notNull(),
  authorId: text('author_id').notNull(),
  note: text('note'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  shippedAt: timestamp('shipped_at', { withTimezone: true }),
})

export const contributionVotes = pgTable(
  'contribution_votes',
  {
    contributionId: uuid('contribution_id')
      .notNull()
      .references(() => contributions.id, { onDelete: 'cascade' }),
    userId: text('user_id').notNull(),
    direction: smallint('direction').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.contributionId, t.userId], name: 'contribution_votes_pk' })],
)

const AREAS = ['dashboard', 'assistant', 'messages', 'website', 'email', 'brand', 'memory', 'drive', 'settings', 'contribute', 'everywhere'] as const

/** Phone-home, install side (migration 0136, plan/contribute-phone-home.md §5). */
export const contributeOutbox = pgTable('contribute_outbox', {
  contributionId: uuid('contribution_id')
    .primaryKey()
    .references(() => contributions.id, { onDelete: 'cascade' }),
  state: text('state', { enum: ['pending', 'scrubbed', 'sent', 'failed', 'excluded'] })
    .default('pending')
    .notNull(),
  summary: text('summary'),
  language: text('language'),
  lastSentHash: text('last_sent_hash'),
  attempts: integer('attempts').default(0).notNull(),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).defaultNow().notNull(),
  lastError: text('last_error'),
  sentAt: timestamp('sent_at', { withTimezone: true }),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** The single sharing row (id = 1); on by default (owner, Q6). The private key is in the secrets store. */
export const contributeShareSettings = pgTable('contribute_share_settings', {
  id: smallint('id').primaryKey().default(1),
  enabled: boolean('enabled').default(true).notNull(),
  installId: uuid('install_id'),
  registeredAt: timestamp('registered_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  lastError: text('last_error'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/** The central board (migration 0137, plan §3): used only where the contribute-hub module is active. */
export const hubInstalls = pgTable('hub_installs', {
  installId: uuid('install_id').primaryKey(),
  publicKey: text('public_key').notNull(),
  appVersion: text('app_version').notNull(),
  registeredAt: timestamp('registered_at', { withTimezone: true }).defaultNow().notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
})

export const hubContributions = pgTable(
  'hub_contributions',
  {
    installId: uuid('install_id')
      .notNull()
      .references(() => hubInstalls.installId, { onDelete: 'cascade' }),
    remoteId: uuid('remote_id').notNull(),
    summary: text('summary').notNull(),
    language: text('language').notNull(),
    kind: text('kind', { enum: ['idea', 'bug', 'polish'] }).notNull(),
    area: text('area', { enum: AREAS }).notNull(),
    status: text('status', { enum: ['requested', 'in_progress', 'shipped', 'declined'] }).notNull(),
    score: integer('score').notNull(),
    appVersion: text('app_version').notNull(),
    createdDay: date('created_day').notNull(),
    shippedDay: date('shipped_day'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.installId, t.remoteId], name: 'hub_contributions_pk' })],
)

export const hubSeenSignatures = pgTable('hub_seen_signatures', {
  signatureHash: text('signature_hash').primaryKey(),
  seenAt: timestamp('seen_at', { withTimezone: true }).defaultNow().notNull(),
})

export const hubRequestCounts = pgTable(
  'hub_request_counts',
  {
    installId: uuid('install_id').notNull(),
    hour: timestamp('hour', { withTimezone: true }).notNull(),
    count: integer('count').default(0).notNull(),
  },
  (t) => [primaryKey({ columns: [t.installId, t.hour], name: 'hub_request_counts_pk' })],
)
