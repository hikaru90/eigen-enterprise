import type { ModuleManifest } from '$lib/kernel/modules'

export const COWORKERS_MODULE_ID = 'coworkers'

export const COWORKERS_CREATE_TOOL = 'coworkers.create'
export const COWORKERS_REMOVE_TOOL = 'coworkers.remove'

/** The writes that wait on the company's approval mode (APPROVAL_REQUIRED_TOOLS). create and remove always ask. */
export const COWORKERS_GATED_TOOLS = ['coworkers.update', 'coworkers.enable', 'coworkers.disable', 'org.set_position'] as const

export const COWORKERS_TOOL_NAMES = [
  'coworkers.templates',
  'coworkers.list',
  'coworkers.get',
  COWORKERS_CREATE_TOOL,
  'coworkers.update',
  'coworkers.enable',
  'coworkers.disable',
  COWORKERS_REMOVE_TOOL,
  'coworkers.runs',
  'org.chart',
  'org.set_position',
] as const

/**
 * AI co-workers and the org chart (plan/phase-ai-coworkers.md C1): AI
 * colleagues with their own seat (title, accountabilities, lens, model, daily
 * cap, reports-to) and the company-wide org chart of people and co-workers.
 * A system module (self-seeded on, core like Members). Internal for now: the
 * Org chart page and Settings → Co-workers come with C5; until then the CLI and
 * the agent reach everything through these tools.
 */
export const coworkersManifest: ModuleManifest = {
  id: COWORKERS_MODULE_ID,
  name: 'Co-workers',
  internal: true,
  version: '0.1.0',
  description: 'AI co-workers with their own roles, models and accountabilities, and the company org chart.',
  toolNamespaces: [COWORKERS_MODULE_ID, 'org'],
  tools: [...COWORKERS_TOOL_NAMES],
  permissions: { roles: ['admin', 'member', 'agent'] },
}
