import type { ModuleManifest } from '$lib/kernel/modules'

export const COMPANY_MODULES_MODULE_ID = 'company-modules'

/** The tool names (single source of truth for the manifest; tools.ts builds them). */
export const COMPANY_MODULES_TOOLS = [
  'modules.list',
  'modules.get',
  'modules.status',
  'modules.logs',
  'modules.source',
  'modules.scaffold',
  'modules.write_file',
  'modules.delete_file',
  'modules.commit',
  'modules.publish',
  'modules.test',
  'modules.deploy',
  'modules.remove',
  'modules.accept_sharing',
]

/**
 * Modules (plan/phase-upgrades-u2.md §8): the box's own vibe-coded modules —
 * scaffold, write, commit, publish, test, deploy and remove them, all as
 * `modules.*` registry tools; Settings → Modules is a client of these. A
 * system module (self-seeded active, part of the OS). The module host
 * (src/lib/kernel/module-host) runs them.
 */
export const companyModulesManifest: ModuleManifest = {
  id: COMPANY_MODULES_MODULE_ID,
  name: 'Modules',
  internal: true,
  version: '0.2.0',
  description: 'Modules built for this company: their code, tests, publishing and deploys.',
  toolNamespaces: [COMPANY_MODULES_MODULE_ID, 'modules'],
  tools: COMPANY_MODULES_TOOLS,
  permissions: { roles: ['admin', 'member', 'agent'] },
}
