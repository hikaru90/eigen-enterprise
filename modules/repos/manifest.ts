import type { ModuleManifest } from '$lib/kernel/modules'

export const REPOS_MODULE_ID = 'repos'

/** The `github.*` namespace is the Website module's deploy tools; this plugin is `repos.*`. */
export const REPOS_TOOL_NAMES = ['repos.list', 'repos.sync_now'] as const

/** Drive source id for this plugin's read-only folders (drive_folder.source). */
export const REPOS_DRIVE_SOURCE = REPOS_MODULE_ID

/**
 * GitHub repos (plan/github-drive.md): read-only copies of selected repos in
 * Drive, kept in sync through a fine-grained token. S0 stub: not registered
 * in modules/index.ts yet — S3 registers it together with its tools.
 */
export const reposManifest: ModuleManifest = {
  id: REPOS_MODULE_ID,
  name: 'GitHub repos',
  version: '0.1.0',
  description:
    'Read-only copies of your GitHub repos in Drive: branches, pull requests, recent activity and docs, kept in sync with a read-only token, with a short summary of what is going on.',
  requires: ['drive'],
  tools: [...REPOS_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
