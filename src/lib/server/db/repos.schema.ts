import { sql } from 'drizzle-orm'
import { bigint, boolean, index, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

/**
 * GitHub repos in Drive (migrations 0134, 0135, 0161, plan/github-drive.md and
 * plan/github-drive-full-mirror.md). Not wired into schema.ts; consumed only by
 * modules/repos. The token lives sealed in one column (AAD = the row id) and is
 * never selected outside the poller.
 */
export const repoSourceTokens = pgTable('repo_source_tokens', {
  id: uuid('id').primaryKey(),
  githubLogin: text('github_login').notNull(),
  tokenSealed: text('token_sealed').notNull(),
  last4: text('last4').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
  addedBy: text('added_by').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  lastError: text('last_error'),
})

export const repoSources = pgTable(
  'repo_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tokenId: uuid('token_id')
      .notNull()
      .references(() => repoSourceTokens.id, { onDelete: 'cascade' }),
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    fullName: text('full_name').notNull(),
    defaultBranch: text('default_branch').notNull(),
    enabled: boolean('enabled').default(true).notNull(),
    dueAt: timestamp('due_at', { withTimezone: true }).defaultNow().notNull(),
    claimedBy: text('claimed_by'),
    claimedUntil: timestamp('claimed_until', { withTimezone: true }),
    etags: jsonb('etags').$type<Record<string, string>>().notNull().default({}),
    branchHeads: jsonb('branch_heads').$type<Record<string, string>>().notNull().default({}),
    /** Migration 0161: 'all' (every file of the default branch) or 'docs' (Markdown only). */
    copyMode: text('copy_mode').notNull().default('all'),
    /** The last fetched state (dates as ISO strings), rendered again on a 304. */
    snapshot: jsonb('snapshot').$type<unknown>(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    lastError: text('last_error'),
    pausedUntil: timestamp('paused_until', { withTimezone: true }),
    /** Migration 0135: the assistant's last good "What's going on" ({summary, highlights, writtenAt}). */
    summary: jsonb('summary').$type<unknown>(),
    /** Why the latest attempt wrote no summary: 'no_model' | 'failed' (then `summary` is stale). */
    summaryErrorKind: text('summary_error_kind'),
    summaryError: text('summary_error'),
    summaryErrorAt: timestamp('summary_error_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('repo_sources_repo_id_unique').on(t.repoId),
    index('repo_sources_due_idx').on(t.dueAt).where(sql`${t.enabled}`),
    index('repo_sources_token_idx').on(t.tokenId),
  ],
)

/**
 * One row per copied file of a repo's default branch (migration 0161): the
 * path's git blob sha and size as of the last sync. Replaces the doc_shas
 * jsonb — 50,000 paths don't belong in one row. Cascades with its repo.
 */
export const repoSourceFiles = pgTable(
  'repo_source_files',
  {
    sourceId: uuid('source_id')
      .notNull()
      .references(() => repoSources.id, { onDelete: 'cascade' }),
    path: text('path').notNull(),
    sha: text('sha').notNull(),
    size: bigint('size', { mode: 'number' }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.sourceId, t.path] })],
)
