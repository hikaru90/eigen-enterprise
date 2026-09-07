import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the website module (single source of truth for the manifest). */
export const WEBSITE_TOOL_NAMES = [
  'website.create_page',
  'website.update_page',
  'website.publish_page',
  'website.get_page',
  'website.list_pages',
] as const

export const websiteManifest: ModuleManifest = {
  id: 'website',
  name: 'Website',
  version: '0.1.0',
  description:
    'Baseline company website: content objects, public page rendering (/s/[slug]), and contact capture as kernel events.',
  tools: [...WEBSITE_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
