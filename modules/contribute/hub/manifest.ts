import type { ModuleManifest } from '$lib/kernel/modules'

export const CONTRIBUTE_HUB_MODULE_ID = 'contribute-hub'

/** The owner's hands on the central board: read what every install shared, revoke an abusive install. */
export const CONTRIBUTE_HUB_TOOL_NAMES = ['contribute_hub.list', 'contribute_hub.get', 'contribute_hub.revoke_install'] as const

/**
 * Contribute hub (plan/contribute-phone-home.md §3): the central board that
 * installs share de-personalised proposals with, over the signed
 * /api/hub/* endpoints. Active only on the owner's install
 * (os.cerberusblue.com) — it is NOT self-seeded: it stays off everywhere until
 * the owner switches it on (kernel.module_activate). While it is off its API
 * answers 404 and the "All installs" tab is not shown. Internal: no sidebar
 * entry and no Plugins card; it lives as a tab on /contribute.
 */
export const contributeHubManifest: ModuleManifest = {
  id: CONTRIBUTE_HUB_MODULE_ID,
  name: 'Contribute hub',
  internal: true,
  version: '0.1.0',
  description: 'The central board: proposals every eigenEnterprise install shared, without names.',
  toolNamespaces: [CONTRIBUTE_HUB_MODULE_ID, 'contribute_hub'],
  tools: [...CONTRIBUTE_HUB_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
