import type { ModuleManifest } from '$lib/kernel/modules'

export const MODULE_HUB_MODULE_ID = 'module-hub'

/** The owner's hands on the module hub: read every published module, its code and runs; summarise a version again. */
export const MODULE_HUB_TOOL_NAMES = [
  'module_hub.list',
  'module_hub.get',
  'module_hub.version',
  'module_hub.tree',
  'module_hub.file',
  'module_hub.summarize',
] as const

/**
 * Module hub (plan/phase-upgrades-u2.md §7): the central box's view of every
 * module installs published — code, versions, the installs running them and
 * a summary. Like the contribute hub it is registered everywhere and NOT
 * self-seeded: off until the owner switches it on (kernel.module_activate),
 * on the central box only. Internal: it lives at Contribute → Modules. While
 * it is off its /api/hub/modules/* endpoints answer 404.
 */
export const moduleHubManifest: ModuleManifest = {
  id: MODULE_HUB_MODULE_ID,
  name: 'Module hub',
  internal: true,
  version: '0.1.0',
  description: 'The central board of modules every eigenEnterprise install published.',
  toolNamespaces: [MODULE_HUB_MODULE_ID, 'module_hub'],
  tools: [...MODULE_HUB_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
