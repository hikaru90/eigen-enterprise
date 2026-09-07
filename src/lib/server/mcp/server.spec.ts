import type { WiredKernel } from '../../../../modules/index'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { ModuleRegistry, InMemoryActivationStore } from '$lib/kernel/modules'
import type { PrincipalStore } from '$lib/kernel/principals'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolContext, ToolDescriptor } from '$lib/kernel/types'

const { handlerMap } = vi.hoisted(() => ({ handlerMap: new Map() }))

vi.mock('@modelcontextprotocol/sdk/server/index.js', () => ({
  Server: class MockServer {
    setRequestHandler(schema: unknown, handler: unknown) {
      handlerMap.set(schema, handler)
    }
  },
}))

vi.mock('@modelcontextprotocol/sdk/types.js', () => ({
  ListToolsRequestSchema: Symbol.for('list-tools'),
  CallToolRequestSchema: Symbol.for('call-tool'),
}))

const noopPrincipalStore: PrincipalStore = {
  getById: async () => null,
  getByApiKey: async () => null,
}

function descriptor(
  name: string,
  module: string,
  handler: (ctx: ToolContext, input: unknown) => Promise<unknown>,
  auditClass: ToolDescriptor['auditClass'] = 'read',
): ToolDescriptor {
  return {
    name,
    module,
    summary: `${name} summary`,
    inputSchema: z.object({ value: z.string() }),
    permission: { roles: ['admin', 'agent'] },
    auditClass,
    handler,
  }
}

async function makeFixtureKernel(activeModules: string[] = []): Promise<{
  kernel: WiredKernel
  eventSink: InMemoryEventSink
  handlerCalls: Array<{ ctx: ToolContext; input: unknown }>
}> {
  const activations = new InMemoryActivationStore()
  const eventSink = new InMemoryEventSink()
  const registry = new KernelRegistry({ eventSink, activationStore: activations })
  const handlerCalls: Array<{ ctx: ToolContext; input: unknown }> = []

  registry.register(
    descriptor('alpha.echo', 'alpha', async (ctx, input) => {
      handlerCalls.push({ ctx, input })
      return { echoed: input }
    }),
  )
  registry.register(
    descriptor('alpha.wipe', 'alpha', async () => ({ wiped: true }), 'mutate'),
  )
  registry.register(
    descriptor('beta.read', 'beta', async () => ({ from: 'beta' })),
  )

  const modules = new ModuleRegistry(activations)
  modules.register({
    id: 'alpha',
    name: 'Alpha',
    version: '0.1.0',
    tools: ['alpha.echo', 'alpha.wipe'],
    permissions: { roles: ['admin'] },
  })
  modules.register({
    id: 'beta',
    name: 'Beta',
    version: '0.1.0',
    tools: ['beta.read'],
    permissions: { roles: ['admin'] },
  })

  for (const id of activeModules) await activations.set(id, true)

  return {
    kernel: {
      registry,
      modules,
      activations,
      principals: noopPrincipalStore,
      approvals: new InMemoryApprovalStore(),
      eventSink,
    },
    eventSink,
    handlerCalls,
  }
}

async function handlers(kernel: WiredKernel) {
  const { createMcpServer } = await import('./server')
  createMcpServer({ userId: 'u1' }, kernel)
  return {
    list: handlerMap.get(Symbol.for('list-tools')) as () => Promise<{
      tools: Array<{ name: string; inputSchema: Record<string, unknown> }>
    }>,
    call: handlerMap.get(Symbol.for('call-tool')) as (request: {
      params: { name: string; arguments?: unknown }
    }) => Promise<{ content: Array<{ type: string; text: string }> }>,
  }
}

describe('createMcpServer over a kernel registry', () => {
  it('lists only tools of active modules (fail closed), with zod-derived input schemas', async () => {
    const { kernel } = await makeFixtureKernel(['alpha'])
    const { list } = await handlers(kernel)

    const result = await list()
    expect(result.tools.map((t) => t.name)).toEqual(['alpha.echo', 'alpha.wipe'])
    expect(result.tools[0].inputSchema).toMatchObject({
      type: 'object',
      required: ['value'],
    })
  })

  it('lists nothing when every module is inactive', async () => {
    const { kernel } = await makeFixtureKernel([])
    const { list } = await handlers(kernel)
    expect((await list()).tools).toEqual([])
  })

  it('dispatches calls through registry.execute with the session-user principal', async () => {
    const { kernel, handlerCalls } = await makeFixtureKernel(['alpha'])
    const { call } = await handlers(kernel)

    const result = await call({
      params: { name: 'alpha.echo', arguments: { value: 'hello' } },
    })
    expect(JSON.parse(result.content[0].text)).toEqual({ echoed: { value: 'hello' } })
    expect(handlerCalls).toHaveLength(1)
    expect(handlerCalls[0].ctx.principal).toEqual({
      id: 'u1',
      kind: 'human',
      roles: ['admin'],
    })
  })

  it('maps Bearer API key callers to an agent principal', async () => {
    const { kernel, handlerCalls } = await makeFixtureKernel(['alpha'])
    const { createMcpServer } = await import('./server')
    createMcpServer(
      { userId: 'u1', authenticatedApiKey: { id: 'key-1', name: 'my-agent' } },
      kernel,
    )
    const call = handlerMap.get(Symbol.for('call-tool')) as (request: {
      params: { name: string; arguments?: unknown }
    }) => Promise<unknown>

    await call({ params: { name: 'alpha.echo', arguments: { value: 'x' } } })
    expect(handlerCalls).toHaveLength(1)
    expect(handlerCalls[0].ctx.principal).toEqual({
      id: 'u1',
      kind: 'agent',
      roles: ['admin', 'agent'],
    })
  })

  it('throws module_inactive for calls into inactive modules', async () => {
    const { kernel } = await makeFixtureKernel([]) // nothing active
    const { call } = await handlers(kernel)

    await expect(call({ params: { name: 'alpha.echo', arguments: { value: 'x' } } })).rejects.toMatchObject(
      { code: 'module_inactive' },
    )
  })

  it('throws for unknown tools', async () => {
    const { kernel } = await makeFixtureKernel(['alpha', 'beta'])
    const { call } = await handlers(kernel)
    await expect(call({ params: { name: 'ghost.tool' } })).rejects.toThrow(/Unknown tool/)
  })

  it('emits a kernel audit event per executed call', async () => {
    const { kernel, eventSink } = await makeFixtureKernel(['alpha'])
    const { call } = await handlers(kernel)
    await call({ params: { name: 'alpha.echo', arguments: { value: 'x' } } })
    expect(eventSink.events).toHaveLength(1)
    expect(eventSink.events[0].payload).toMatchObject({ tool: 'alpha.echo', ok: true })
  })
})

describe('listMcpTools (pure)', () => {
  it('is exported and filters by activation without a server', async () => {
    const { listMcpTools } = await import('./server')
    const { kernel } = await makeFixtureKernel(['beta'])

    expect(
      (await listMcpTools(kernel.registry, kernel.activations)).map((t) => t.name),
    ).toEqual(['beta.read'])
    expect(await listMcpTools(kernel.registry)).toHaveLength(3)
  })
})
