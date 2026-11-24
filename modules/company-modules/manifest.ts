import type { ModuleManifest } from '$lib/kernel/modules'

export const COMPANY_MODULES_MODULE_ID = 'company-modules'

/**
 * Modules (plan/phase-upgrades-u2.md §8): the box's own vibe-coded modules —
 * scaffold, write, commit, publish, test, deploy and remove them, all as
 * `modules.*` registry tools; Settings → Modules is a client of these. A
 * system module (self-seeded active, part of the OS). Tools arrive with
 * stream A; the contract commit (§9.0) wires the empty manifest.
 */
export const companyModulesManifest: ModuleManifest = {
  id: COMPANY_MODULES_MODULE_ID,
  name: 'Modules',
  internal: true,
  version: '0.1.0',
  description: 'Modules built for this company: their code, tests, publishing and deploys.',
  toolNamespaces: [COMPANY_MODULES_MODULE_ID, 'modules'],
  tools: [],
  permissions: { roles: ['admin', 'member', 'agent'] },
}
