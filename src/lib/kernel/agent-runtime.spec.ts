import type { AgentConfig } from './agent'
import type { EngineContext, LoopEngine } from './engine'
import type { ToolDescriptor, ToolContext } from './types'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentRuntime } from './agent-runtime'
import { InMemoryApprovalStore, StaticApprovalPolicy } from './approvals'
import { KernelError } from './errors'
import { InMemoryEventSink } from './events'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from './modules'
import { KernelRegistry } from './registry'

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    personaName: 'Agent One',
    description: 'test agent',
    loopEngine: 'builtin-json',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    enabled: true,
    ...overrides,
  }
}

function tool(
  name: string,
  module: string,
  roles: string[],
  handler: (ctx: ToolContext, input: unknown) => Promise<unknown> = async (_ctx, input) => ({
    echoed: input,
  }),
): ToolDescriptor {
  return {
    name,
    module,
    summary: `summary of ${name}`,
    auditClass: 'read',
    inputSchema: z.looseObject({}),
    permission: { roles },
    handler,
  }
}

const modOn = (id: string): ModuleManifest => ({
  id,
  name: id,
  version: '0.1.0',
  tools: [],
  permissions: { roles: ['admin', 'agent'] },
})

type Fixture = {
  runtime: AgentRuntime
  registry: KernelRegistry
  activations: InMemoryActivationStore
  sink: InMemoryEventSink
  run: ReturnType<typeof vi.fn>
  engine: LoopEngine
}

function makeFixture(options: {
  tools?: ToolDescriptor[]
  manifests?: ModuleManifest[]
  spendFn?: (agentId: string) => number
  roles?: string[]
  engineRun?: LoopEngine['run']
} = {}): Fixture {
  const activations = new InMemoryActivationStore()
  const modules = new ModuleRegistry(activations)
  for (const manifest of options.manifests ?? []) modules.register(manifest)
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
  })
  for (const t of options.tools ?? []) registry.register(t)

  const sink = new InMemoryEventSink()
  const run = vi.fn(options.engineRun ?? (async () => 'engine reply'))
  const engine: LoopEngine = { run }

  const runtime = new AgentRuntime({
    registry,
    isToolActive: (name) => modules.isToolActive(name),
    eventSink: sink,
    ...(options.spendFn ? { spendFn: options.spendFn } : {}),
    rolesFor: () => options.roles ?? ['agent'],
  })
  runtime.registerEngine('builtin-json', engine)

  return { runtime, registry, activations, sink, run, engine }
}

describe('AgentRuntime — registration', () => {
  it('registers, lists, and returns agents', () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig({ id: 'b-agent' }))
    fx.runtime.registerAgent(agentConfig({ id: 'a-agent' }))

    expect(fx.runtime.listAgents().map((a) => a.id)).toEqual(['a-agent', 'b-agent'])
    expect(fx.runtime.getAgent('a-agent')?.personaName).toBe('Agent One')
    expect(fx.runtime.getAgent('ghost')).toBeUndefined()
  })

  it('fails loud on duplicate agent ids', () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())

    expect(() => fx.runtime.registerAgent(agentConfig())).toThrowError(KernelError)
    expect(() => fx.runtime.registerAgent(agentConfig())).toThrowError(/already registered/)
    try {
      fx.runtime.registerAgent(agentConfig())
    } catch (err) {
      expect((err as KernelError).code).toBe('duplicate_agent')
    }
  })

  it('enable/disable and stop mutate the config; unknown ids fail loud', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())

    fx.runtime.disable('agent-1')
    expect(fx.runtime.getAgent('agent-1')?.enabled).toBe(false)
    fx.runtime.enable('agent-1')
    expect(fx.runtime.getAgent('agent-1')?.enabled).toBe(true)

    expect(() => fx.runtime.enable('ghost')).toThrowError(/unknown agent/)
    expect(() => fx.runtime.disable('ghost')).toThrowError(/unknown agent/)
    await expect(fx.runtime.stop('ghost')).rejects.toMatchObject({ code: 'unknown_agent' })
  })

  it('stop marks the agent disabled and emits agent.stopped (v0: no in-flight cancellation)', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())

    await fx.runtime.stop('agent-1')

    expect(fx.runtime.getAgent('agent-1')?.enabled).toBe(false)
    const stopped = fx.sink.events.find((e) => e.type === 'agent.stopped')
    expect(stopped).toBeDefined()
    expect(stopped!.payload).toEqual({ agentId: 'agent-1' })
  })

  it('fails loud on duplicate engine ids', () => {
    const fx = makeFixture()
    expect(() => fx.runtime.registerEngine('builtin-json', { run: async () => 'x' })).toThrowError(
      /already registered/,
    )
  })
})

describe('AgentRuntime — dispatch', () => {
  it('runs the engine and emits dispatched + replied with metadata-only payloads', async () => {
    const fx = makeFixture({ engineRun: async () => 'a very long reply' })
    fx.runtime.registerAgent(agentConfig())

    const reply = await fx.runtime.dispatch('agent-1', 'session-9', 'hello')

    expect(reply).toBe('a very long reply')
    const types = fx.sink.events.map((e) => e.type)
    expect(types).toContain('agent.dispatched')
    expect(types).toContain('agent.replied')

    const dispatched = fx.sink.events.find((e) => e.type === 'agent.dispatched')!
    expect(dispatched.payload).toEqual({ agentId: 'agent-1', sessionId: 'session-9' })
    expect(dispatched.principalId).toBe('agent-1')

    const replied = fx.sink.events.find((e) => e.type === 'agent.replied')!
    // No reply content in payloads — ever.
    expect(replied.payload).toEqual({ agentId: 'agent-1', sessionId: 'session-9', replyLength: 17 })
    expect(JSON.stringify(fx.sink.events)).not.toContain('a very long reply')
    expect(JSON.stringify(fx.sink.events)).not.toContain('hello')
  })

  it('rejects disabled agents with agent_disabled', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig({ enabled: false }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi')).rejects.toMatchObject({
      code: 'agent_disabled',
    })
    expect(fx.run).not.toHaveBeenCalled()
  })

  it('rejects unknown agents with unknown_agent', async () => {
    const fx = makeFixture()
    await expect(fx.runtime.dispatch('ghost', 's', 'hi')).rejects.toMatchObject({
      code: 'unknown_agent',
    })
  })

  it('fails loud when the configured engine is not registered', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig({ loopEngine: 'pi' }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi')).rejects.toMatchObject({
      code: 'unknown_engine',
    })
    expect(fx.run).not.toHaveBeenCalled()
  })
})

describe('AgentRuntime — budget', () => {
  it('throws budget_exceeded and emits agent.budget_exceeded when the cap is reached', async () => {
    const fx = makeFixture({ spendFn: () => 5 })
    fx.runtime.registerAgent(agentConfig({ spendCapUsd: 5 }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi')).rejects.toMatchObject({
      code: 'budget_exceeded',
    })
    expect(fx.run).not.toHaveBeenCalled()

    const event = fx.sink.events.find((e) => e.type === 'agent.budget_exceeded')
    expect(event).toBeDefined()
    expect(event!.payload).toEqual({
      agentId: 'agent-1',
      sessionId: 's',
      spendUsd: 5,
      spendCapUsd: 5,
    })
  })

  it('runs uncapped agents and agents below the cap', async () => {
    const fx = makeFixture({ spendFn: () => 1 })
    fx.runtime.registerAgent(agentConfig({ spendCapUsd: 2 }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi')).resolves.toBe('engine reply')
  })

  it('recordSpend accumulates on the default in-memory accumulator and reaches the engine', async () => {
    let observed = 0
    const fx = makeFixture({
      engineRun: async (_sid, _input, ctx) => {
        observed = ctx.spendUsd()
        return 'ok'
      },
    })
    fx.runtime.registerAgent(agentConfig())
    fx.runtime.recordSpend('agent-1', 0.25)
    fx.runtime.recordSpend('agent-1', 0.75)

    await fx.runtime.dispatch('agent-1', 's', 'hi')
    expect(observed).toBe(1)
  })
})

describe('AgentRuntime — tool surface + execution path', () => {
  const memoryTool = tool('memory.echo', 'memory', ['agent'])
  const ownerTool = tool('email.send_mail', 'email', ['owner'])
  const adminTool = tool('kernel.module_list', 'kernel', ['admin'])
  it("toolScope 'all' exposes active-module tools whose roles the agent holds", async () => {
    const fx = makeFixture({
      tools: [memoryTool, ownerTool, adminTool],
      manifests: [modOn('memory'), modOn('email'), modOn('kernel')],
      roles: ['agent'],
    })
    await fx.activations.set('memory', true)
    await fx.activations.set('email', true)
    await fx.activations.set('kernel', true)
    fx.runtime.registerAgent(agentConfig())

    let listed: string[] = []
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      listed = ctx.listTools().map((t) => t.name)
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi')
    expect(listed).toEqual(['memory.echo'])
  })

  it('toolScope module allowlist restricts the surface even for active, permitted tools', async () => {
    const fx = makeFixture({
      tools: [memoryTool, ownerTool],
      manifests: [modOn('memory'), modOn('email')],
      roles: ['owner', 'agent'],
    })
    await fx.activations.set('memory', true)
    await fx.activations.set('email', true)
    fx.runtime.registerAgent(agentConfig({ toolScope: { modules: ['memory'] } }))

    let listed: string[] = []
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      listed = ctx.listTools().map((t) => t.name)
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi')
    expect(listed).toEqual(['memory.echo'])
  })

  it('excludes tools of inactive modules (fail closed) at dispatch time', async () => {
    const fx = makeFixture({
      tools: [memoryTool],
      manifests: [modOn('memory')],
      roles: ['agent'],
    })
    // memory intentionally left inactive.
    fx.runtime.registerAgent(agentConfig())

    let listed: string[] = ['unset']
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      listed = ctx.listTools().map((t) => t.name)
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi')
    expect(listed).toEqual([])
  })

  it('hands the agent principal (id = agent id) and routes executeTool through the kernel', async () => {
    const seen: ToolContext[] = []
    const fx = makeFixture({
      tools: [
        tool('memory.echo', 'memory', ['agent'], async (ctx, input) => {
          seen.push(ctx)
          return { echoed: input }
        }),
      ],
      manifests: [modOn('memory')],
      roles: ['agent'],
    })
    await fx.activations.set('memory', true)
    fx.runtime.registerAgent(agentConfig())

    const responses = ['{"tool":"memory.echo","arguments":{"x":1}}', '{"answer":"done"}']
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      // Simulate the builtin-json engine: one tool call, then answer.
      await ctx.executeTool('memory.echo', { x: 1 })
      const listing = ctx.listTools()
      expect(listing.map((t) => t.name)).toEqual(['memory.echo'])
      return responses[1]
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi')

    expect(seen).toHaveLength(1)
    expect(seen[0].principal).toEqual({ id: 'agent-1', kind: 'agent', roles: ['agent'] })
    expect(typeof seen[0].requestId).toBe('string')
  })

  it('EngineContext.emit defaults principal + kernel source and reaches the sink', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())

    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      await ctx.emit({ type: 'custom.engine_event', payload: { step: 1 } })
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi')

    const event = fx.sink.events.find((e) => e.type === 'custom.engine_event')
    expect(event).toBeDefined()
    expect(event!.principalId).toBe('agent-1')
    expect(event!.source).toBe('urn:eigenenterprise:kernel')
  })
})

describe('AgentRuntime — stream sink pass-through', () => {
  it('passes dispatch stream sinks through to the engine context untouched', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())

    const stream = (_delta: string) => {}
    const surfaceEvent = (_event: { type: 'tool.preview'; tool: string; inputSummary: null }) => {}
    let seen: EngineContext | undefined
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      seen = ctx
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi', { stream, surfaceEvent })

    expect(seen?.stream).toBe(stream)
    expect(seen?.surfaceEvent).toBe(surfaceEvent)
  })

  it('leaves stream sinks undefined when dispatch is called without them', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())

    let seen: EngineContext | undefined
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      seen = ctx
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi')

    expect(seen?.stream).toBeUndefined()
    expect(seen?.surfaceEvent).toBeUndefined()
  })
})
