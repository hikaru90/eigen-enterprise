/**
 * The chat-gateway port, owned by the kernel (plan/kernel-open-api.md rule 1).
 *
 * Session, allowlist, and brain contracts live here as kernel-owned types:
 * modules import them from `$lib/kernel/gateway` — modules may import the
 * kernel, the kernel never imports modules. The concrete implementations
 * (Telegram transport, DB-backed stores) stay in modules/chat-gateway; the
 * orchestrator depends only on this port.
 */

export const CHAT_GATEWAY_MODULE_ID = 'chat-gateway'

/**
 * Allowlist admin tool names (owner-only). Descriptors are built by
 * modules/orchestrator/allowlist-tools.ts around an AllowlistStore instance;
 * they are listed here because the chat-gateway manifest owns this surface.
 */
export const CHAT_GATEWAY_ALLOWLIST_TOOLS = [
  'chat-gateway.allowlist_add',
  'chat-gateway.allowlist_remove',
  'chat-gateway.allowlist_list',
] as const

export type AllowlistEntry = {
  platform: string
  externalUserId: string
  principalId: string
}

export type AllowlistStore = {
  isAllowed(platform: string, externalUserId: string): Promise<boolean>
  /** Principal the external user is mapped to, or null when absent (fail closed). */
  principalFor(platform: string, externalUserId: string): Promise<string | null>
  add(platform: string, externalUserId: string, principalId: string): Promise<void>
  remove(platform: string, externalUserId: string): Promise<void>
  list(): Promise<AllowlistEntry[]>
}

export type GatewaySession = {
  id: string
  platform: string
  externalChatId: string
  principalId: string
  lastSeenAt: string
}

export type SessionStore = {
  /** Upsert by (platform, externalChatId); keeps the session id stable. */
  touch(platform: string, externalChatId: string, principalId: string): Promise<{ id: string }>
  get(platform: string, externalChatId: string): Promise<{ id: string; principalId: string } | null>
}

export type TelegramSessionRef = {
  sessionId: string
  platform: string
  externalChatId: string
  principalId: string
}

export type Brain = {
  respond(session: TelegramSessionRef, text: string): Promise<string>
}
