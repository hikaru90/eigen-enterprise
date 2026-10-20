import type { ModuleManifest } from '$lib/kernel/modules'
import { GITHUB_CONNECT_TOOL_NAMES, GITHUB_TOOL_NAMES } from './github/manifest'
import { SUBSTRATE_TOOL_NAMES } from './hosting/manifest'
import { APP_TOOL_NAMES } from './apps/manifest'

export const WEBSITE_MODULE_ID = 'website'

/** Site-content tool names (namespace `website`). */
export const WEBSITE_TOOL_NAMES = [
  'website.create_page',
  'website.update_page',
  'website.publish_page',
  'website.get_page',
  'website.list_pages',
  'website.site_info',
] as const

/**
 * Website (plan/phase-platform.md step 1): the company site, plus hosting on
 * this server (ee: domains, apps, secrets; namespace `substrate`, changes by
 * a human only, D11) and GitHub as the source provider (namespace `github`).
 * Tool names are unchanged; this module owns all three namespaces. A system
 * module: self-seeded active like the kernel (a box can't forget its hosting).
 */
export const websiteManifest: ModuleManifest = {
  id: WEBSITE_MODULE_ID,
  name: 'Website',
  version: '0.2.0',
  description: 'Your apps, services and site: link GitHub repos, deploy, domains, logs.',
  toolNamespaces: [WEBSITE_MODULE_ID, 'substrate', 'github'],
  tools: [...WEBSITE_TOOL_NAMES, ...GITHUB_CONNECT_TOOL_NAMES, ...APP_TOOL_NAMES, ...SUBSTRATE_TOOL_NAMES, ...GITHUB_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent', 'service'] },
}
