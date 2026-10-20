import { sql } from 'drizzle-orm'
import { bigint, boolean, pgTable, text, timestamp, unique, uniqueIndex } from 'drizzle-orm/pg-core'

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
 * Repositories connected to the company (migrations 0093, 0094). Unique by
 * GitHub's numeric repo id (stable across renames) plus branch where the id is
 * known, and always by (lower(full_name), branch). No tokens and no key
 * material: `github_app` rows record the installation id (a short-lived token
 * is minted when needed); `deploy_key` rows record ee's key id (the key pair
 * lives sealed in ee's secret store) and have no repo id.
 */
export const githubConnectedRepos = pgTable(
  'github_connected_repos',
  {
    repoId: bigint('repo_id', { mode: 'number' }),
    branch: text('branch').notNull(),
    fullName: text('full_name').notNull(),
    htmlUrl: text('html_url').notNull(),
    cloneUrl: text('clone_url').notNull(),
    visibility: text('visibility', { enum: ['public', 'private'] }).notNull(),
    authKind: text('auth_kind', { enum: ['public', 'github_app', 'deploy_key'] }).notNull(),
    installationId: bigint('installation_id', { mode: 'number' }),
    deployKeyId: text('deploy_key_id'),
    connectedBy: text('connected_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [
    unique('github_connected_repos_repo_branch_unique').on(t.repoId, t.branch),
    uniqueIndex('github_connected_repos_name_branch_unique').on(
      sql`lower(${t.fullName})`,
      t.branch,
    ),
  ],
)
