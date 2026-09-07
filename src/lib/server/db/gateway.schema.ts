import { pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

/**
 * Chat gateway tables (Phase 0) — Telegram allowlist mapping external platform
 * users to kernel principals, and chat↔session mappings for the orchestrator.
 * Not wired into schema.ts; consumed only by modules/chat-gateway stores.
 */

export const kernelGatewayAllowlist = pgTable('kernel_gateway_allowlist', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull(),
  externalUserId: text('external_user_id').notNull(),
  principalId: text('principal_id').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('kernel_gateway_allowlist_platform_external_user_id_unique').on(
    table.platform,
    table.externalUserId,
  ),
])

export const kernelGatewaySessions = pgTable('kernel_gateway_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  platform: text('platform').notNull(),
  externalChatId: text('external_chat_id').notNull(),
  principalId: text('principal_id').notNull(),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  unique('kernel_gateway_sessions_platform_external_chat_id_unique').on(
    table.platform,
    table.externalChatId,
  ),
])
