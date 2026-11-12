import type { WiredKernel } from '../../../../modules/index'
import type { McpToolContext } from './tools'
import { randomUUID } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { moduleInactiveError, type ActivationStore } from '$lib/kernel/modules'
import { toolInputJsonSchema, toolOutputJsonSchema } from '$lib/kernel/openapi'
import type { KernelRegistry } from '$lib/kernel/registry'
import { sanitizeMcpToolResult } from '$lib/server/observability/strip-embeddings'

export type McpToolListing = {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  outputSchema?: Record<string, unknown>
}

/**
 * Pure MCP tools/list projection of a kernel registry. When an activation
 * store is given, tools of inactive modules are omitted (fail closed).
 */
export async function listMcpTools(
  registry: KernelRegistry,
  activations?: Pick<ActivationStore, 'get'>,
): Promise<McpToolListing[]> {
  const out: McpToolListing[] = []
  for (const tool of registry.list()) {
    if (activations && !(await activations.get(tool.module))) continue
    out.push({
      name: tool.name,
      description: tool.summary,
      inputSchema: toolInputJsonSchema(tool.inputSchema),
      ...(tool.outputSchema === undefined
        ? {}
        : { outputSchema: toolOutputJsonSchema(tool.outputSchema) }),
    })
  }
  return out
}

/**
 * MCP callers are session users (kind human) or Bearer API keys (kind agent).
 * Phase 0 grants both the admin role — this preserves the historical MCP
 * behavior (any authenticated principal may call) until principals.ts is wired
 * into request auth with real role assignments.
 */
function toKernelPrincipal(context: McpToolContext): {
  id: string
  kind: 'human' | 'agent'
  roles: string[]
} {
  if (context.authenticatedApiKey) {
    return { id: context.userId, kind: 'agent', roles: ['admin', 'agent'] }
  }
  return { id: context.userId, kind: 'human', roles: ['admin'] }
}

export function createMcpServer(
  context: McpToolContext,
  /** The booted process kernel (routes pass `await appKernel()`). */
  kernel: WiredKernel,
): Server {
  const server = new Server(
    {
      name: 'eigen-memory',
      version: '0.1.0',
    },
    {
      capabilities: {
        tools: {},
      },
    },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: await listMcpTools(kernel.registry, kernel.activations),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name
    const descriptor = kernel.registry.get(name)
    if (!descriptor) {
      throw new Error(`Unknown tool: ${name}`)
    }
    if (!(await kernel.activations.get(descriptor.module))) {
      throw await moduleInactiveError(kernel.activations, descriptor.module, name)
    }

    const result = sanitizeMcpToolResult(
      await kernel.registry.execute(name, request.params.arguments ?? {}, {
        principal: toKernelPrincipal(context),
        requestId: randomUUID(),
      }),
    )
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result),
        },
      ],
    }
  })

  return server
}
