import type { EventSink } from '$lib/kernel/events'
import type { AllowlistStore, Brain, SessionStore } from '$lib/kernel/gateway'
import type { ModuleManifest } from '$lib/kernel/modules'
import type { ToolDescriptor } from '$lib/kernel/types'
import type { AppDatabase } from '$lib/server/db/context'
import { kernelGatewayAllowlist, kernelGatewaySessions } from '$lib/server/db/gateway.schema'
import { DbAllowlistStore, DbSessionStore } from './db-stores'
import { chatGatewayEnv } from './env'
import { chatGatewayManifest, type ChatGatewayStatsFn } from './manifest'
import { HttpTelegramClient, TelegramGateway, type TelegramClient } from './telegram'

export type ChatGatewayOptions = {
  /** Process env (or any env record); must contain TELEGRAM_BOT_TOKEN — validated loudly. */
  env: Record<string, string | undefined>
  db: AppDatabase
  eventSink: EventSink
  brain: Brain
}

export type ChatGatewayBoot = {
  manifest: ModuleManifest
  statusTool: ToolDescriptor
  gateway: TelegramGateway
  client: TelegramClient
  allowlist: AllowlistStore
  sessions: SessionStore
}

/**
 * Boot wiring for the orchestrator: env → HTTP client, DB-backed allowlist and
 * session stores, kernel event sink. The poll loop stays with the caller:
 * `offset = await boot.gateway.runCycle(offset)`.
 */
export function createChatGateway(options: ChatGatewayOptions): ChatGatewayBoot {
  const { botToken } = chatGatewayEnv(options.env)
  const client = new HttpTelegramClient({ botToken })
  const allowlist = new DbAllowlistStore(options.db)
  const sessions = new DbSessionStore(options.db)
  const gateway = new TelegramGateway({
    allowlist,
    sessions,
    events: options.eventSink,
    brain: options.brain,
    client,
  })
  const stats: ChatGatewayStatsFn = async () => ({
    allowlistCount: await options.db.$count(kernelGatewayAllowlist),
    sessionsCount: await options.db.$count(kernelGatewaySessions),
  })
  const { manifest, statusTool } = chatGatewayManifest(stats)
  return { manifest, statusTool, gateway, client, allowlist, sessions }
}
