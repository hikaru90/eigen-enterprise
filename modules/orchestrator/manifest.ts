import type { ModuleManifest } from '$lib/kernel/modules'
import { DEV_AGENT_TOOL_NAMES } from './dev-agent/tool-names'
import { REPO_TOOL_NAMES } from './repo/manifest'
import { ROADMAP_TOOL_NAMES } from './roadmap/manifest'

export const ORCHESTRATOR_MODULE_ID = 'orchestrator'

/**
 * The agent's own machinery (plan/phase-platform.md step 1): repo hands
 * (namespace `repo`), the dev agent (`dev-agent`) and the build log /
 * roadmap (`roadmap`). Internal: no owner-facing module card or page; the
 * tools stay available to the agent under their existing names.
 */
export const orchestratorManifest: ModuleManifest = {
  id: ORCHESTRATOR_MODULE_ID,
  name: 'Agent tools',
  version: '0.1.0',
  description: "The agent's own hands: repo worktrees, the dev agent, and the build log.",
  internal: true,
  toolNamespaces: [ORCHESTRATOR_MODULE_ID, 'repo', 'dev-agent', 'roadmap'],
  tools: [...REPO_TOOL_NAMES, ...DEV_AGENT_TOOL_NAMES, ...ROADMAP_TOOL_NAMES],
  permissions: { roles: ['owner', 'admin', 'agent'] },
}
