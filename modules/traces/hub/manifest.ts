import type { ModuleManifest } from '$lib/kernel/modules'

export const TRACE_HUB_MODULE_ID = 'trace-hub'

/** The owner's reads of every box's product signals (plan/traces-phone-home.md §4). */
export const TRACE_HUB_TOOL_NAMES = ['trace_hub.stats', 'trace_hub.list', 'trace_hub.get'] as const

/**
 * Trace hub (plan/traces-phone-home.md T3): the makers' store of Tier A spans that every box
 * sends over the signed /api/hub/traces endpoints (the install identity is the Contribute hub's).
 * Active only on the makers' install (os.cerberusblue.com) — NOT self-seeded: it stays off
 * everywhere until the owner switches it on (kernel.module_activate). While it is off its API
 * answers 404. Internal: no sidebar entry; its page is /settings/traces-hub.
 */
export const traceHubManifest: ModuleManifest = {
  id: TRACE_HUB_MODULE_ID,
  name: 'Product signals hub',
  internal: true,
  version: '0.1.0',
  description: 'Usage statistics every eigenEnterprise box shared: failure rates, durations, tokens and cost by tool, model and version. No content.',
  toolNamespaces: [TRACE_HUB_MODULE_ID, 'trace_hub'],
  tools: [...TRACE_HUB_TOOL_NAMES],
  permissions: { roles: ['owner', 'admin', 'agent'] },
}
