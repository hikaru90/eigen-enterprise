import {
  bigint,
  boolean,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core'

/**
 * Kernel tables (Phase 0) — principals, append-only audit events, module
 * activation state, and approval requests. Not yet wired into schema.ts /
 * repositories; consumed by src/lib/kernel stores in a later phase.
 */

export const kernelPrincipals = pgTable('kernel_principals', {
  id: text('id').primaryKey(),
  kind: text('kind', { enum: ['human', 'agent', 'service'] }).notNull(),
  displayName: text('display_name'),
  roles: text('roles').array().notNull(),
  apiKeyHash: text('api_key_hash'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Append-only audit log — no unique constraint on ts. */
export const kernelEvents = pgTable('kernel_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  ts: timestamp('ts', { withTimezone: true }).defaultNow().notNull(),
  type: text('type').notNull(),
  principalId: text('principal_id'),
  source: text('source'),
  payload: jsonb('payload').notNull(),
})

export const kernelModuleActivations = pgTable('kernel_module_activations', {
  moduleId: text('module_id').primaryKey(),
  active: boolean('active').default(false).notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull(),
})

export const kernelApprovals = pgTable('kernel_approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  toolName: text('tool_name').notNull(),
  input: jsonb('input').notNull(),
  principalId: text('principal_id').notNull(),
  status: text('status', { enum: ['pending', 'approved', 'denied'] }).notNull(),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  /** Migration 0143: when an always-ask tool ran on this approval (one approval, one call). */
  consumedAt: timestamp('consumed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Company-wide approval mode (migration 0090): single row id='company', seeded 'ask'. */
export const kernelApprovalMode = pgTable('kernel_approval_mode', {
  id: text('id').primaryKey().default('company'),
  mode: text('mode', { enum: ['ask', 'reasonable', 'allow_all'] }).notNull(),
  updatedBy: text('updated_by').notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})

/**
 * The company's own modules (migration 0179, plan/phase-upgrades-u2.md §4.6):
 * one row per module, its deployed manifest/receipt/commit and the kernel's
 * state (src/lib/kernel/module-host/types.ts ModuleRecord).
 */
export const kernelModules = pgTable('kernel_modules', {
  id: text('id').primaryKey(),
  ownerUserId: text('owner_user_id').notNull(),
  manifest: jsonb('manifest'),
  receipt: jsonb('receipt'),
  commit: text('commit'),
  bundleSha256: text('bundle_sha256'),
  state: text('state', {
    enum: ['unpublished', 'publishing', 'deploying', 'connecting', 'running', 'failed', 'off'],
  }).notNull(),
  reason: text('reason'),
  stateSince: timestamp('state_since', { withTimezone: true }).notNull(),
  firstDeployedAt: timestamp('first_deployed_at', { withTimezone: true }),
  deployedFrom: text('deployed_from', {
    enum: ['unpublished', 'publishing', 'deploying', 'connecting', 'running', 'failed', 'off'],
  }),
  deployedBy: text('deployed_by'),
  pendingDeploy: jsonb('pending_deploy').$type<{ commit: string; by: string; at: string }>(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Every receipted (published) commit of a company module (migration 0179). */
export const kernelModuleVersions = pgTable(
  'kernel_module_versions',
  {
    moduleId: text('module_id').notNull(),
    commit: text('commit').notNull(),
    version: text('version').notNull(),
    bundleSha256: text('bundle_sha256').notNull(),
    manifest: jsonb('manifest').notNull(),
    receipt: jsonb('receipt').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ name: 'kernel_module_versions_pk', columns: [t.moduleId, t.commit] })],
)

/** Event delivery per company module (migration 0179, §4.4). */
export const kernelModuleEventCursor = pgTable('kernel_module_event_cursor', {
  moduleId: text('module_id').primaryKey(),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
  lastTs: timestamp('last_ts', { withTimezone: true }),
  lastId: uuid('last_id'),
  attempts: integer('attempts').default(0).notNull(),
  failingSince: timestamp('failing_since', { withTimezone: true }),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }),
})

/** The owner's one-time module sharing OK (migration 0179, §6.6): one row, id 'company'. */
export const kernelModuleSharing = pgTable('kernel_module_sharing', {
  id: text('id').primaryKey().default('company'),
  acceptedBy: text('accepted_by').notNull(),
  acceptedAt: timestamp('accepted_at', { withTimezone: true }).defaultNow().notNull(),
})

/** Company export runs (migration 0168, plan/phase-export.md X1); the archive is <state dir>/exports/<id>.zip. */
export const companyExport = pgTable('company_export', {
  id: uuid('id').primaryKey().defaultRandom(),
  requestedBy: text('requested_by').notNull(),
  status: text('status', { enum: ['pending', 'running', 'done', 'failed', 'deleted'] }).notNull().default('pending'),
  bytes: bigint('bytes', { mode: 'number' }),
  summary: jsonb('summary').$type<CompanyExportSummary>(),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  expiresAt: timestamp('expires_at', { withTimezone: true }),
})

export type CompanyExportSummary = { tables: number; rows: number; privateRows: number; files: number; excluded: number }
