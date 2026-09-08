import { z } from 'zod'
import {
  CHAT_GATEWAY_ALLOWLIST_TOOLS,
  CHAT_GATEWAY_MODULE_ID,
} from '$lib/kernel/gateway'
import type { ModuleManifest } from '$lib/kernel/modules'
import type { ToolDescriptor } from '$lib/kernel/types'

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
