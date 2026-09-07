import { z } from 'zod'
import type { ModuleManifest } from '$lib/kernel/modules'
import type { ToolDescriptor } from '$lib/kernel/types'

export const CHAT_GATEWAY_MODULE_ID = 'chat-gateway'

/**
 * Allowlist admin tool names (owner-only). Descriptors are built by
 * modules/orchestrator/allowlist-tools.ts around an AllowlistStore instance;
 * they are listed here because this manifest owns the chat-gateway surface.
 */
export const CHAT_GATEWAY_ALLOWLIST_TOOLS = [
  'chat-gateway.allowlist_add',
  'chat-gateway.allowlist_remove',
  'chat-gateway.allowlist_list',
] as const

export type ChatGatewayStats = {
  allowlistCount: number
  sessionsCount: number
}

export type ChatGatewayStatsFn = () => Promise<ChatGatewayStats>

export function chatGatewayManifest(stats: ChatGatewayStatsFn): {
  manifest: ModuleManifest
  statusTool: ToolDescriptor
} {
  const manifest: ModuleManifest = {
    id: CHAT_GATEWAY_MODULE_ID,
    name: 'Chat Gateway',
    version: '0.1.0',
    description:
      'Telegram long-polling gateway: allowlisted platform users are mapped to kernel principals and routed to the orchestrator.',
    tools: ['chat-gateway.status', ...CHAT_GATEWAY_ALLOWLIST_TOOLS],
    permissions: { roles: ['owner', 'admin'] },
  }

  const statusTool: ToolDescriptor = {
    name: 'chat-gateway.status',
    module: CHAT_GATEWAY_MODULE_ID,
    summary: 'Allowlist and gateway session counts (read-only).',
    inputSchema: z.object({}),
    permission: { roles: ['owner', 'admin'] },
    auditClass: 'read',
    handler: async () => stats(),
  }

  return { manifest, statusTool }
}
