import type { AgentRuntime } from './agent-runtime'
import type { ModuleManifest } from './modules'
import type { ToolDescriptor } from './types'
import { z } from 'zod'

/**
 * Harness admin surface (admin-tools.ts is the pattern): agent.list /
 * agent.enable / agent.disable as regular kernel tools wrapping the
 * AgentRuntime. Registered from the orchestrator bootstrap next to the
 * existing registrations; permissioned, audited, approval-gated like any
 * other kernel tool — there is no out-of-band agent channel.
 */

export const AGENT_ADMIN_MODULE_ID = 'agent'

/** Tool names owned by the agents module (single source of truth for the manifest). */
export const AGENT_ADMIN_TOOL_NAMES = ['agent.list', 'agent.enable', 'agent.disable'] as const

/** The agents module manifest (admin tools are gated like any other module). */
export const agentAdminManifest: ModuleManifest = {
  id: AGENT_ADMIN_MODULE_ID,
  name: 'Agent Admin',
  // Harness machinery: never an owner-facing module card or page.
  internal: true,
  version: '0.1.0',
  description: 'Harness agent administration: list hosted agents, enable and disable them.',
  tools: [...AGENT_ADMIN_TOOL_NAMES],
  permissions: { roles: ['admin'] },
}

export type AgentAdminToolDeps = {
  runtime: AgentRuntime
}

const agentListInput = z.object({})
const agentIdInput = z.object({ agent_id: z.string().min(1) })

/** Factory for the agent admin ToolDescriptors — pure, deps injected, testable. */
export function createAgentAdminTools(deps: AgentAdminToolDeps): ToolDescriptor[] {
  return [
    {
      name: 'agent.list',
      module: AGENT_ADMIN_MODULE_ID,
      summary: 'List all registered harness agents with their configuration.',
      auditClass: 'read',
      inputSchema: agentListInput,
      permission: { roles: ['admin', 'agent'] },
      handler: async () => deps.runtime.listAgents(),
    },
    {
      name: 'agent.enable',
      module: AGENT_ADMIN_MODULE_ID,
      summary: 'Enable a registered agent (dispatches are accepted again).',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof agentIdInput>) => `Switched on the agent “${input.agent_id}”`,
      inputSchema: agentIdInput,
      permission: { roles: ['owner'] },
      handler: async (_ctx, input) => {
        const parsed = agentIdInput.parse(input)
        deps.runtime.enable(parsed.agent_id)
        return { agent_id: parsed.agent_id, enabled: true }
      },
    },
    {
      name: 'agent.disable',
      module: AGENT_ADMIN_MODULE_ID,
      summary: 'Disable a registered agent (new dispatches fail loud with agent_disabled).',
      auditClass: 'mutate',
      activity: (input: z.infer<typeof agentIdInput>) => `Switched off the agent “${input.agent_id}”`,
      inputSchema: agentIdInput,
      permission: { roles: ['owner'] },
      handler: async (_ctx, input) => {
        const parsed = agentIdInput.parse(input)
        deps.runtime.disable(parsed.agent_id)
        return { agent_id: parsed.agent_id, enabled: false }
      },
    },
  ]
}
