import type { ModuleManifest } from '$lib/kernel/modules'

export const MEMBERS_MODULE_ID = 'members'

export const MEMBERS_TOOL_NAMES = [
  'members.list',
  'members.invite',
  'members.set_role',
  'members.group_list',
  'members.group_create',
  'members.group_update',
  'members.group_delete',
] as const

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
  description: 'The people in your company, their roles and groups; invites by link.',
  tools: [...MEMBERS_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
