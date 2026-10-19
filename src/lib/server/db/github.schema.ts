import { bigint, boolean, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

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
