import type { ModuleManifest } from '$lib/kernel/modules'

export const MESSAGES_MODULE_ID = 'messages'

/**
 * Writes act as the calling person (UI parity: the CLI can do what /messages
 * can). The agent principal stays read-only (owner decision W-2: no @agent in
 * channels) — write tools are not granted the `agent` role.
 */
export const MESSAGES_WRITE_TOOLS = [
  'messages.create_channel',
  'messages.open_dm',
  'messages.upload_attachments',
  'messages.post',
  'messages.edit',
  'messages.delete',
  'messages.react',
  'messages.mark_read',
  'messages.set_do_not_disturb',
] as const

export const MESSAGES_TOOL_NAMES = [
  'messages.list_channels',
  'messages.read',
  'messages.thread',
  'messages.members',
  ...MESSAGES_WRITE_TOOLS,
] as const

/**
 * Messages: the team's chat — channels (public/private) and direct messages
 * between members (plan/phase-workspace.md C1). A system module; the people's
 * surface is /messages, the CLI's is these tools.
 */
export const messagesManifest: ModuleManifest = {
  id: MESSAGES_MODULE_ID,
  name: 'Messages',
  version: '0.1.0',
  description: 'Team chat: channels and direct messages between the people in your company.',
  tools: [...MESSAGES_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
