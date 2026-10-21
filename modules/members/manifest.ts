import type { ModuleManifest } from '$lib/kernel/modules'

export const MEMBERS_MODULE_ID = 'members'

export const MEMBERS_TOOL_NAMES = ['members.list', 'members.invite', 'members.set_role'] as const

/**
 * Members: who belongs to the company and with which role (owner | admin |
 * member). A system module (self-seeded active, part of the OS); the owner's
 * surface is Settings → Members, the agent's is these tools.
 */
export const membersManifest: ModuleManifest = {
  id: MEMBERS_MODULE_ID,
  name: 'Members',
  internal: true,
  version: '0.1.0',
  description: 'The people in your company and their roles; invites by email.',
  tools: [...MEMBERS_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
