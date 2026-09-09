import {
  bigserial,
  boolean,
  index,
  jsonb,
  pgTable,
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
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
})

/**
 * Durable append-only agent session log (phase-3 M1) — the conversation
 * history the builtin-json engine derives per-session context from. Insertion
 * order (bigserial id) is the ordering; no update/delete paths exist.
 */
export const kernelAgentSessionEvents = pgTable(
  'kernel_agent_session_events',
  {
    id: bigserial('id', { mode: 'number' }).primaryKey(),
    sessionId: text('session_id').notNull(),
    agentId: text('agent_id').notNull(),
    kind: text('kind', { enum: ['user', 'assistant'] }).notNull(),
    payload: jsonb('payload')
      .$type<Record<string, unknown>>()
      .notNull()
      .default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index('kernel_agent_session_events_session_idx').on(table.sessionId, table.id)],
)
