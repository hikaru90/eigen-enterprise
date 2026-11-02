import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the memory module (single source of truth for the manifest). */
export const MEMORY_TOOL_NAMES = [
  'memory.capture_thought',
  'memory.retrieve_thoughts',
  'memory.list_projects',
  'memory.get_project_timeline',
  'memory.list_text_files',
  'memory.get_text_file',
  'memory.search_text_files',
] as const

/** Memory is a system module (always on): see SYSTEM_MODULE_IDS. */
export const MEMORY_MODULE_ID = 'memory'

export const memoryManifest: ModuleManifest = {
  id: MEMORY_MODULE_ID,
  name: 'Memory',
  version: '0.1.0',
  description:
    'Thought capture, hybrid retrieval, and GTD project/text-note tools over the eigen memory system.',
  tools: [...MEMORY_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
