import { describe, expect, it, vi } from 'vitest'

// Hermetic: listing tools reads schemas only; no handler, env or DB is touched.
vi.mock('$env/dynamic/private', () => ({ default: {}, env: {} }))

import { ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { registerAdminTools } from '$lib/kernel/admin-bootstrap'
import { AGENT_ADMIN_MODULE_ID, agentAdminManifest, createAgentAdminTools } from '$lib/kernel/agent-admin'
import type { AgentRuntime } from '$lib/kernel/agent-runtime'
import { InMemoryApprovalModeStore, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import type { SettingsPort } from '$lib/kernel/settings-tools'
import { registerModuleTools } from '$lib/kernel/wiring'
import { buildKernel } from '../../../../modules/index'
import { listMcpTools } from './server'

/**
 * Contract: the production MCP tools/list — every module tool, the kernel
 * admin + settings tools and the agent admin tools, all modules active — is
 * a result MCP clients accept. One non-object inputSchema (settings.update's
 * discriminated union, 2026-11-19) made Claude Code reject the whole list.
 */
async function productionToolList() {
  const kernel = buildKernel({
    activations: new InMemoryActivationStore(),
    eventSink: new InMemoryEventSink(),
    approvalStore: new InMemoryApprovalStore(),
    approvalMode: new InMemoryApprovalModeStore('ask'),
    vcsCommitter: null,
  })
  const notInAListing = async (): Promise<never> => {
    throw new Error('a tools/list never calls the settings port')
  }
  const settings: SettingsPort = {
    modelFor: notInAListing,
    person: notInAListing,
    read: notInAListing,
    apply: notInAListing,
  }
  await registerAdminTools(kernel, { settings })
  kernel.modules.register(agentAdminManifest)
  registerModuleTools(
    kernel.registry,
    kernel.modules,
    createAgentAdminTools({ runtime: {} as AgentRuntime }),
  )
  for (const module of kernel.modules.list()) await kernel.activations.set(module.id, true)
  await kernel.activations.set(AGENT_ADMIN_MODULE_ID, true)

  const tools = await listMcpTools(kernel.registry, kernel.activations)
  return { tools, registered: kernel.registry.list().length }
}

describe('MCP tools/list contract (all registered tools)', () => {
  it('lists every registered tool, settings.update included', async () => {
    const { tools, registered } = await productionToolList()
    expect(tools).toHaveLength(registered)
    expect(tools.map((t) => t.name)).toContain('settings.update')
  })

  it('advertises a top-level type "object" inputSchema (and outputSchema) for every tool', async () => {
    const { tools } = await productionToolList()
    const offenders = tools
      .filter(
        (t) =>
          t.inputSchema.type !== 'object' ||
          (t.outputSchema !== undefined && t.outputSchema.type !== 'object'),
      )
      .map((t) => t.name)
    expect(offenders).toEqual([])
    // LLM tool APIs reject top-level combinators even next to type: "object".
    const combinators = tools
      .filter((t) => ['oneOf', 'anyOf', 'allOf'].some((k) => k in t.inputSchema))
      .map((t) => t.name)
    expect(combinators).toEqual([])
  })

  it('is a valid tools/list result for the MCP SDK client schema', async () => {
    const { tools } = await productionToolList()
    const parsed = ListToolsResultSchema.safeParse({ tools })
    expect(parsed.success ? [] : parsed.error.issues).toEqual([])
  })
})
