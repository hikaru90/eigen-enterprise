import type { ModuleManifest } from '$lib/kernel/modules'

export const DRIVE_MODULE_ID = 'drive'

export const DRIVE_TOOL_NAMES = ['drive.list', 'drive.read', 'drive.write_text'] as const

/**
 * Drive: the company's files and folders (plan/phase-workspace.md D1). A
 * system module (self-seeded active); the people's surface is /drive, the
 * agent's is these tools — every call access-checked like a page request.
 */
export const driveManifest: ModuleManifest = {
  id: DRIVE_MODULE_ID,
  name: 'Drive',
  version: '0.1.0',
  description: 'Folders and files for the whole company: upload, share, preview; Markdown and CSV keep revisions.',
  tools: [...DRIVE_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
