import type { WiredKernel } from '../modules/index'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { InMemoryActivationStore } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import { createMcpServer } from '$lib/server/mcp/server'
import { schemaToType } from './sdk-gen'
import { createCoreApiClient, mcpHttpTransport, CoreApiCallError } from './sdk/core-api'

describe('schemaToType', () => {
  it('maps the zod-emitted subset to TypeScript', () => {
    expect(schemaToType({ type: 'string' })).toBe('string')
    expect(schemaToType({ type: ['string', 'null'] })).toBe('string | null')
    expect(schemaToType({ type: 'string', enum: ['a', 'b'] })).toBe('"a" | "b"')
    expect(schemaToType({ const: 3 })).toBe('3')
    expect(schemaToType({ type: 'array', items: { type: 'integer' } })).toBe('Array<number>')
    expect(schemaToType({ anyOf: [{ type: 'string' }, { type: 'null' }] })).toBe('string | null')
    expect(
      schemaToType({
        type: 'object',
        propertyNames: { type: 'string' },
        additionalProperties: { type: 'number' },
      }),
    ).toBe('Record<string, number>')
    expect(schemaToType({ type: 'object', properties: {}, additionalProperties: false })).toBe(
      'Record<string, never>',
    )
    expect(schemaToType({})).toBe('unknown')
  })

  it('marks optional fields and nests objects', () => {
    expect(
      schemaToType({
        type: 'object',
        properties: { id: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } } },
        required: ['id'],
      }),
    ).toBe('{\n  "id": string\n  "tags"?: Array<string>\n}')
  })
})

/**
 * The SDK's wire against the REAL MCP endpoint handler (createMcpServer over a
 * kernel registry, the streamable HTTP transport /api/mcp uses), in process.
 */
function inProcessMcp(kernel: WiredKernel): typeof fetch {
  return (async (_url: string, init: RequestInit) => {
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    })
    const server = createMcpServer(
      { userId: 'user-1', authenticatedApiKey: { id: 'key-1' } as never },
      kernel,
    )
    await server.connect(transport)
    return transport.handleRequest(new Request('http://box.test/api/mcp', init))
  }) as typeof fetch
}

describe('the SDK over MCP', () => {
  const activations = new InMemoryActivationStore()
  const registry = new KernelRegistry({ activationStore: activations })
  registry.register({
    name: 'probe.echo',
    module: 'probe',
    summary: 'echo',
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ echoed: z.string() }),
    permission: { roles: ['agent'] },
    auditClass: 'read',
    handler: async (_ctx, input) => ({ echoed: (input as { text: string }).text }),
  })
  const kernel = { registry, activations } as unknown as WiredKernel

  it('calls a tool and returns its structured output', async () => {
    await activations.set('probe', true)
    const transport = mcpHttpTransport({
      baseUrl: 'http://box.test',
      apiKey: 'k',
      fetch: inProcessMcp(kernel),
    })
    await expect(transport.callTool('probe.echo', { text: 'hi' })).resolves.toEqual({
      echoed: 'hi',
    })
    // The generated client is a typed pass-through over the same transport.
    const client = createCoreApiClient(transport)
    expect(typeof client.call).toBe('function')
  })

  it("a refused call fails loud with the core's reason", async () => {
    await activations.set('probe', false)
    const transport = mcpHttpTransport({
      baseUrl: 'http://box.test',
      apiKey: 'k',
      fetch: inProcessMcp(kernel),
    })
    await expect(transport.callTool('probe.echo', { text: 'hi' })).rejects.toBeInstanceOf(
      CoreApiCallError,
    )
  })

  it('refuses to build without a base URL or key', () => {
    expect(() => mcpHttpTransport({ baseUrl: '', apiKey: 'k' })).toThrow(/baseUrl/)
    expect(() => mcpHttpTransport({ baseUrl: 'http://x', apiKey: ' ' })).toThrow(/apiKey/)
  })
})
