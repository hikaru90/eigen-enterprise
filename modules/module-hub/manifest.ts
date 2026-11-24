import type { ModuleManifest } from '$lib/kernel/modules'

export const MODULE_HUB_MODULE_ID = 'module-hub'

/**
 * Module hub (plan/phase-upgrades-u2.md §7): the central box's view of every
 * module installs published — code, versions, the installs running them and
 * a summary. Like the contribute hub it is registered everywhere and NOT
 * self-seeded: off until the owner switches it on (kernel.module_activate),
 * on the central box only. Internal: it lives at Contribute → Modules. Tools
 * arrive with stream C; the contract commit (§9.0) wires the empty manifest.
 */
export const moduleHubManifest: ModuleManifest = {
  id: MODULE_HUB_MODULE_ID,
  name: 'Module hub',
  internal: true,
  version: '0.1.0',
  description: 'The central board of modules every eigenEnterprise install published.',
  toolNamespaces: [MODULE_HUB_MODULE_ID, 'module_hub'],
  tools: [],
  permissions: { roles: ['admin', 'agent'] },
}
