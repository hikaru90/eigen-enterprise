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
 * discriminated union, 2026-11-19) made Claude Code reject the whole list;
 * schemas outside the strict function subset (the zod `$schema` root key,
 * type unions, nested combinators — 2026-11-20) made Cloud Code reject it.
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

  // The strict function-schema subset every MCP client accepts — MCP plus
  // the OpenAPI/Gemini function subset. One schema outside it is enough for
  // a strict client (Cloud Code, 2026-11-20) to reject the whole list, so
  // the visitor checks every advertised node, at any depth.
  it('advertises every schema inside the strict function subset', async () => {
    const { tools } = await productionToolList()
    const subsetKeys = new Set([
      'type',
      'title',
      'description',
      'enum',
      'items',
      'properties',
      'required',
      'nullable',
      'format',
      'minimum',
      'maximum',
      'minItems',
      'maxItems',
    ])
    const subsetFormats = new Set(['date-time', 'date', 'time'])
    const offenders: string[] = []
    const visit = (node: unknown, path: string, tool: string): void => {
      if (typeof node !== 'object' || node === null) return
      const schema = node as Record<string, unknown>
      for (const key of Object.keys(schema)) {
        if (!subsetKeys.has(key)) offenders.push(`${tool}${path}: unsupported key ${key}`)
      }
      if (schema.type !== undefined && typeof schema.type !== 'string') {
        offenders.push(`${tool}${path}: non-scalar type ${JSON.stringify(schema.type)}`)
      }
      if (schema.format !== undefined && !subsetFormats.has(schema.format as string)) {
        offenders.push(`${tool}${path}: format ${String(schema.format)}`)
      }
      if (Array.isArray(schema.enum) && schema.enum.length === 0) {
        offenders.push(`${tool}${path}: empty enum`)
      }
      // An untyped node survives only as an honest mixed-union collapse,
      // which always carries its shapes in the description.
      if (schema.type === undefined && !('description' in schema)) {
        offenders.push(`${tool}${path}: untyped node without description`)
      }
      const properties = schema.properties
      if (typeof properties === 'object' && properties !== null) {
        for (const [key, child] of Object.entries(properties as Record<string, unknown>)) {
          visit(child, `${path}.properties.${key}`, tool)
        }
      }
      if (schema.items !== undefined) visit(schema.items, `${path}.items`, tool)
    }
    for (const tool of tools) {
      visit(tool.inputSchema, '', tool.name)
      if (tool.outputSchema !== undefined) visit(tool.outputSchema, '.outputSchema', tool.name)
    }
    expect(offenders).toEqual([])
  })

  it('is a valid tools/list result for the MCP SDK client schema', async () => {
    const { tools } = await productionToolList()
    const parsed = ListToolsResultSchema.safeParse({ tools })
    expect(parsed.success ? [] : parsed.error.issues).toEqual([])
  })
})
