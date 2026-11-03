import type { ModuleManifest } from '$lib/kernel/modules'

export const MESSAGES_MODULE_ID = 'messages'

/** Read-only for the agent in v1 (owner decision W-2: no @agent in channels, no posting tool). */
export const MESSAGES_TOOL_NAMES = ['messages.list_channels', 'messages.read'] as const

/**
 * Messages: the team's chat — channels (public/private) and direct messages
 * between members (plan/phase-workspace.md C1). A system module; the people's
 * surface is /messages, the agent's is the read tools.
 */
export const messagesManifest: ModuleManifest = {
  id: MESSAGES_MODULE_ID,
  name: 'Messages',
  version: '0.1.0',
  description: 'Team chat: channels and direct messages between the people in your company.',
  tools: [...MESSAGES_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
