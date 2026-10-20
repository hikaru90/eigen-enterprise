import { bigint, boolean, pgTable, primaryKey, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * GitHub source-provider tables (migration 0085). Not wired into schema.ts;
 * consumed only by modules/github. Credentials live sealed in one column.
 */
export const githubConnection = pgTable('github_connection', {
  id: text('id').primaryKey().default('github'),
  appId: bigint('app_id', { mode: 'number' }).notNull(),
  appSlug: text('app_slug').notNull(),
  clientId: text('client_id').notNull(),
  htmlUrl: text('html_url').notNull(),
  sealedCredentials: text('sealed_credentials').notNull(),
  installationId: bigint('installation_id', { mode: 'number' }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

export const githubAppLinks = pgTable('github_app_links', {
  workload: text('workload').primaryKey(),
  repoFullName: text('repo_full_name').notNull(),
  ref: text('ref').notNull(),
  autoDeploy: boolean('auto_deploy').default(false).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/**
 * Repositories connected to the company (migration 0093). Keyed by GitHub's
 * numeric repo id (stable across renames) plus branch. No tokens: private
 * repos record the installation id, and a short-lived installation token is
 * minted from the sealed App key whenever one is needed (deploy, last commit).
 */
export const githubConnectedRepos = pgTable(
  'github_connected_repos',
  {
    repoId: bigint('repo_id', { mode: 'number' }).notNull(),
    branch: text('branch').notNull(),
    fullName: text('full_name').notNull(),
    htmlUrl: text('html_url').notNull(),
    cloneUrl: text('clone_url').notNull(),
    visibility: text('visibility', { enum: ['public', 'private'] }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }),
    connectedBy: text('connected_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [primaryKey({ columns: [t.repoId, t.branch] })],
)
