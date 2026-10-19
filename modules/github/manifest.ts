import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the github module (single source of truth for the manifest). */
export const GITHUB_TOOL_NAMES = [
  'github.status',
  'github.repos_list',
  'github.app_create',
  'github.app_deploy',
  'github.auto_deploy',
] as const

/**
 * GitHub as a source provider for this server (plan/phase-substrate.md D12):
 * the company's own GitHub App, created from Settings → Hosting; repos it can
 * see become deployable apps on ee. ee itself never talks to GitHub — this
 * module fetches into ee's local mirrors with short-lived installation tokens.
 */
export const githubManifest: ModuleManifest = {
  id: 'github',
  name: 'GitHub',
  version: '0.1.0',
  description:
    'Connect a GitHub App; deploy repositories it can see as apps on this server; auto-deploy on push when the owner turned it on.',
  tools: [...GITHUB_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent', 'service'] },
}

export const GITHUB_MODULE_ID = githubManifest.id
