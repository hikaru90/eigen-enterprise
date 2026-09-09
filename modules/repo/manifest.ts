import type { ModuleManifest } from '$lib/kernel/modules'

/** Tool names owned by the repo module (single source of truth for the manifest). */
export const REPO_TOOL_NAMES = [
  'repo.worktree_create',
  'repo.run',
  'repo.write_file',
  'repo.read_file',
  'repo.merge',
] as const

export const repoManifest: ModuleManifest = {
  id: 'repo',
  name: 'Repo',
  version: '0.1.0',
  description:
    'The agent’s repo hands: worktree sandboxes, allowlisted commands, safe file read/write, and a verified, approval-gated merge into the instance repo.',
  tools: [...REPO_TOOL_NAMES],
  permissions: { roles: ['owner', 'admin', 'agent'] },
}
