import type { ToolDescriptor } from './types'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryActivationStore } from './modules'
import { generateOpenApi, toolOutputJsonSchema } from './openapi'
import { KernelRegistry } from './registry'

/**
 * Surface parity: MCP tools/list and the OpenAPI document must expose the
 * exact same tool set, and the JSON Schemas must agree on required fields.
 * Uses in-memory implementations only (no server, no DB).
 */

function tool(
  name: string,
  module: string,
  schema: z.ZodType,
  outputSchema?: z.ZodType,
): ToolDescriptor {
  return {
    name,
    module,
    summary: `${name} summary`,
    inputSchema: schema,
    ...(outputSchema === undefined ? {} : { outputSchema }),
    permission: { roles: ['admin', 'agent'] },
    auditClass: 'read',
    handler: async (_ctx, input) => ({ ok: input }),
  }
}

async function makeFixture() {
  const registry = new KernelRegistry()
  registry.register(tool('alpha.search', 'alpha', z.object({ query: z.string(), top_k: z.number().optional() })))
  registry.register(tool('alpha.get', 'alpha', z.object({ id: z.string() })))
  registry.register(tool('beta.list', 'beta', z.object({ limit: z.number().optional() })))
  registry.register(tool('beta.send', 'beta', z.object({ body: z.string() }), z.object({ ok: z.boolean() })))

  const activations = new InMemoryActivationStore()
  await activations.set('alpha', true)
  await activations.set('beta', true)

  return { registry, activations }
}

function requiredOf(schema: Record<string, unknown>): string[] {
  const required = schema.required
  return Array.isArray(required) ? [...required].sort() : []
}

describe('MCP ↔ OpenAPI surface parity', () => {
  it('exposes every registered tool in both surfaces', async () => {
    const { registry, activations } = await makeFixture()
    const { listMcpTools } = await import('$lib/server/mcp/server')

    const mcp = await listMcpTools(registry, activations)
    const doc = generateOpenApi(registry, { title: 'parity', version: '0.0.0' })

    const mcpNames = mcp.map((t) => t.name).sort()
    const openApiNames = Object.keys(doc.paths)
      .map((path) => path.replace('/api/kernel/tools/', ''))
      .sort()
    const registryNames = registry.list().map((t) => t.name).sort()

    expect(mcpNames).toEqual(registryNames)
    expect(openApiNames).toEqual(registryNames)
    expect(mcpNames).toEqual(['alpha.get', 'alpha.search', 'beta.list', 'beta.send'])
  })

  it('agrees on required input fields between MCP schema and OpenAPI body schema', async () => {
    const { registry, activations } = await makeFixture()
    const { listMcpTools } = await import('$lib/server/mcp/server')

    const mcp = await listMcpTools(registry, activations)
    const doc = generateOpenApi(registry, { title: 'parity', version: '0.0.0' })

    for (const listing of mcp) {
      const op = doc.paths[`/api/kernel/tools/${listing.name}`].post
      expect(op.requestBody?.required).toBe(true)
      expect(requiredOf(listing.inputSchema)).toEqual(
        requiredOf(op.requestBody?.content['application/json'].schema ?? {}),
      )
    }

    const search = mcp.find((t) => t.name === 'alpha.search')
    expect(requiredOf(search?.inputSchema ?? {})).toEqual(['query'])
  })

  it('agrees on module tags and omits inactive modules from MCP while documenting the registry', async () => {
    const { registry, activations } = await makeFixture()
    const { listMcpTools } = await import('$lib/server/mcp/server')
    await activations.set('beta', false)

    const mcp = await listMcpTools(registry, activations)
    expect(mcp.map((t) => t.name)).toEqual(['alpha.search', 'alpha.get'])

    const doc = generateOpenApi(registry, { title: 'parity', version: '0.0.0' })
    for (const [path, { post }] of Object.entries(doc.paths)) {
      const toolName = path.replace('/api/kernel/tools/', '')
      const moduleId = toolName.slice(0, toolName.indexOf('.'))
      expect(post.tags).toEqual([moduleId])
    }
    // OpenAPI documents the full registered surface; gating is enforced at the call layer.
    expect(Object.keys(doc.paths)).toHaveLength(4)
  })

  it('round-trips a declared outputSchema identically across registry, MCP listing, and OpenAPI 200', async () => {
    const { registry, activations } = await makeFixture()
    const { listMcpTools } = await import('$lib/server/mcp/server')

    const descriptor = registry.get('beta.send')
    expect(descriptor?.outputSchema).toBeDefined()
    const expected = toolOutputJsonSchema(descriptor!.outputSchema!)

    const mcp = await listMcpTools(registry, activations)
    const listing = mcp.find((t) => t.name === 'beta.send')
    expect(listing?.outputSchema).toEqual(expected)

    const doc = generateOpenApi(registry, { title: 'parity', version: '0.0.0' })
    const responseSchema =
      doc.paths['/api/kernel/tools/beta.send'].post.responses['200'].content?.['application/json']
        .schema
    expect(responseSchema).toEqual(expected)

    const plain = mcp.find((t) => t.name === 'alpha.search')
    expect(plain).toBeDefined()
    expect('outputSchema' in plain!).toBe(false)
    const plainResponse =
      doc.paths['/api/kernel/tools/alpha.search'].post.responses['200'].content?.['application/json']
        .schema
    expect(plainResponse).toEqual({})
  })
})
