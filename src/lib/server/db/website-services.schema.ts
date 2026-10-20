import { bigint, boolean, index, pgTable, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Services deployed from connected GitHub repos (migration 0095). Not wired
 * into schema.ts, like the GitHub tables; consumed only by modules/website/apps.
 * No contract (it lives in ee's company repo) and no env values (ee's sealed store).
 */
export const websiteServices = pgTable(
  'website_services',
  {
    name: text('name').primaryKey(),
    kind: text('kind', { enum: ['web', 'backend'] }).notNull(),
    repoFullName: text('repo_full_name').notNull(),
    branch: text('branch').notNull(),
    repoId: bigint('repo_id', { mode: 'number' }),
    authKind: text('auth_kind', { enum: ['public', 'github_app', 'deploy_key'] }).notNull(),
    host: text('host'),
    autoDeploy: boolean('auto_deploy').default(false).notNull(),
    state: text('state', { enum: ['new', 'deploying', 'healthy', 'failed'] })
      .default('new')
      .notNull(),
    lastRev: text('last_rev'),
    lastError: text('last_error'),
    lastDeployedAt: timestamp('last_deployed_at', { withTimezone: true }),
    lastDeployedBy: text('last_deployed_by'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (t) => [index('website_services_repo_branch_idx').on(t.repoId, t.branch)],
)
