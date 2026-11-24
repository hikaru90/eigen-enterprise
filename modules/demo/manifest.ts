import type { ModuleManifest } from '$lib/kernel/modules'

export const DEMO_MODULE_ID = 'demo'

export const DEMO_SEED_TOOL = 'demo.seed_company'
export const DEMO_STATUS_TOOL = 'demo.status'
export const DEMO_GUEST_ACCESS_GET_TOOL = 'demo.guest_access_get'
export const DEMO_GUEST_ACCESS_SET_TOOL = 'demo.guest_access_set'
export const DEMO_TOOL_NAMES = [
  DEMO_SEED_TOOL,
  DEMO_STATUS_TOOL,
  DEMO_GUEST_ACCESS_GET_TOOL,
  DEMO_GUEST_ACCESS_SET_TOOL,
] as const

/**
 * The demo company (plan/phase-demo-company.md DC1): fills a freshly claimed
 * company with Northwind Studio, a made-up agency, through the registry tools
 * — for the hosted demo box. NOT self-seeded: it is off on every company until
 * the owner switches it on (kernel.module_activate). Internal: no sidebar
 * entry, no Plugins card, no page — a demo visitor never sees it.
 */
export const demoManifest: ModuleManifest = {
  id: DEMO_MODULE_ID,
  name: 'Demo company',
  internal: true,
  version: '0.1.0',
  description:
    'Fills a freshly claimed company with Northwind Studio, a made-up design agency: people, contacts, projects, messages, calendar, documents, brand and website.',
  tools: [...DEMO_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
