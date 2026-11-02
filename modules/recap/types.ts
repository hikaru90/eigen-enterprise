import type { EventSink } from '$lib/kernel/events'
import type { AppDatabase } from '$lib/server/db/context'

/**
 * Recap module contract: the company reports to its owner. A scheduled run
 * aggregates the last 24h of kernel_events into a deterministic, metadata-only
 * summary and delivers it to allowlisted Telegram owner chats. Web/chat-thread
 * delivery is out of scope (chat persistence is owned elsewhere) — this module
 * only emits a `recap.completed` kernel event with counts + window.
 */

export const RECAP_MODULE_ID = 'recap'

/** Tool names owned by the recap module (single source of truth for the manifest). */
export const RECAP_TOOL_NAMES = ['recap.run_now'] as const

/** Emitted after a recap run (deliver or skip); metadata only. */
export const RECAP_COMPLETED_EVENT = 'recap.completed'

/**
 * Event types the recap aggregates — the exact strings emitted across the
 * codebase: kernel/agent-runtime.ts (agent.*), kernel/registry.ts
 * (tool.executed), modules/chat-gateway/telegram.ts (gateway.telegram.*),
 * modules/website/contact.ts
 * (website.contact.captured). Exact-match whitelist, no heuristics.
 */
export const RECAP_EVENT_TYPES = [
  'agent.dispatched',
  'agent.replied',
  'agent.stopped',
  'agent.budget_exceeded',
  'tool.executed',
  'gateway.telegram.message',
  'gateway.telegram.denied',
  'website.contact.captured',
] as const

export type RecapEventType = (typeof RECAP_EVENT_TYPES)[number]

/**
 * The only payload fields a recap line may quote — same field-whitelist
 * discipline as the activity feed. Message/reply text, errors, chat ids,
 * user ids and spend figures never reach the recap.
 */
export const RECAP_PAYLOAD_FIELDS = ['agentId', 'runId', 'green', 'ok'] as const

/**
 * Outbound Telegram port. Structural on purpose (boundary guard: modules never
 * import other modules) — the chat-gateway's HttpTelegramClient satisfies it
 * without a cross-module import; composition roots pass the real client in.
 */
export type TelegramSender = {
  sendMessage(chatId: string, text: string): Promise<void>
}

/**
 * Allowlist read port (structural): satisfied by the chat-gateway's
 * DbAllowlistStore. Owner chats are resolved as gateway sessions whose
 * principal is currently allowlisted on the Telegram platform.
 */
export type AllowlistReader = {
  list(): Promise<Array<{ platform: string; externalUserId: string; principalId: string }>>
}

export const RECAP_PLATFORM = 'telegram'

export type RecapDeps = {
  db: AppDatabase
  telegram: TelegramSender
  allowlist: AllowlistReader
  eventSink: EventSink
}
