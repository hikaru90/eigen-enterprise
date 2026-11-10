import type { ModuleManifest } from '$lib/kernel/modules'

export const CONTRIBUTE_MODULE_ID = 'contribute'

/** The agent's hands on the board: read what people asked for, pick it up, ship it. */
export const CONTRIBUTE_TOOL_NAMES = ['contribute.list', 'contribute.get', 'contribute.update'] as const

/**
 * Contribute (ported from Eigen's Contribute board): everyone in the company
 * proposes improvements to the app from the top bar's "Contribute" button and
 * votes on the board at /contribute. An agent picks proposals up later
 * through these tools (in-app assistant or `ee` CLI) and moves them along
 * requested → in progress → shipped, with a note people can read.
 * A system module (self-seeded active); internal: the board is reached from
 * the top bar, never a sidebar entry.
 */
export const contributeManifest: ModuleManifest = {
  id: CONTRIBUTE_MODULE_ID,
  name: 'Contribute',
  internal: true,
  version: '0.1.0',
  description: 'Ideas, bugs and polish requests from the people in your company, voted on and picked up by an agent.',
  tools: [...CONTRIBUTE_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
