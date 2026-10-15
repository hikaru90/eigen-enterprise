import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the roadmap module (single source of truth for the manifest). */
export const ROADMAP_TOOL_NAMES = [
  'roadmap.list_items',
  'roadmap.add_item',
  'roadmap.update_item',
] as const

export const roadmapManifest: ModuleManifest = {
  id: 'roadmap',
  name: 'Extension Roadmap',
  version: '0.1.0',
  description:
    "The company's build log and queue: what shipped, what is in progress, what is planned — rendered under /settings/extensions and maintained through these tools.",
  tools: [...ROADMAP_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
