import { pgTable, serial, text, timestamp } from 'drizzle-orm/pg-core'

/**
 * Durable agent conversation index (plan/phase-durable.md D7) — Postgres keeps
 * the index, pi-durable's SQLite file keeps the transcript. Company-level
 * (kernel-side, no RLS like all kernel tables): maps conversation keys
 * ("<agentId>:<sessionId>") to pi-durable conversation ids and carries the
 * pi.provider sessionId — the crash-safe attribution key every gateway model
 * call resolves back to `llm_user_id`. pi-durable ids are branded bigints —
 * stored as text. Consumed only by src/lib/server/agent/conversation-index.
 */
export const durableConversations = pgTable('durable_conversations', {
  id: serial('id').primaryKey(),
  conversationKey: text('conversation_key').notNull().unique(),
  agentId: text('agent_id').notNull(),
  llmUserId: text('llm_user_id').notNull(),
  piConversationId: text('pi_conversation_id').notNull(),
  providerSessionId: text('provider_session_id').notNull().unique(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
})
