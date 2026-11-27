import type { AgentConfig } from './agent'
import type { EngineContext, LoopEngine } from './engine'
import type { PersonRef } from './principals'
import type { ToolDescriptor, ToolContext } from './types'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentRuntime } from './agent-runtime'
import { InMemoryApprovalStore, StaticApprovalPolicy } from './approvals'
import { KernelError } from './errors'
import { InMemoryEventSink } from './events'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from './modules'
import { KernelRegistry } from './registry'

/** The person a dispatch acts as (CB3: every dispatch names one). */
const ann: PersonRef = { id: 'ann', roles: ['member'] }
const asAnn = { person: ann }

function agentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: 'agent-1',
    personaName: 'Agent One',
    description: 'test agent',
    loopEngine: 'durable',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    instructions: 'engine-default',
    actsAs: 'person',
    task: 'assistant.turn',
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
  })
  runtime.registerEngine('durable', engine)

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
    expect(() => fx.runtime.registerEngine('durable', { run: async () => 'x' })).toThrowError(
      /already registered/,
    )
  })
})

describe('AgentRuntime — dispatch', () => {
  it('runs the engine and emits dispatched + replied with metadata-only payloads', async () => {
    const fx = makeFixture({ engineRun: async () => 'a very long reply' })
    fx.runtime.registerAgent(agentConfig())

    const reply = await fx.runtime.dispatch('agent-1', 'session-9', 'hello', undefined, asAnn)

    expect(reply).toBe('a very long reply')
    const types = fx.sink.events.map((e) => e.type)
    expect(types).toContain('agent.dispatched')
    expect(types).toContain('agent.replied')

    // Provenance: the person is the principal; the brain (agent-1) carried the turn.
    const dispatched = fx.sink.events.find((e) => e.type === 'agent.dispatched')!
    expect(dispatched.payload).toEqual({ agentId: 'agent-1', sessionId: 'session-9', via: 'brain' })
    expect(dispatched.principalId).toBe('ann')

    const replied = fx.sink.events.find((e) => e.type === 'agent.replied')!
    // No reply content in payloads — ever.
    expect(replied.payload).toEqual({ agentId: 'agent-1', sessionId: 'session-9', replyLength: 17, via: 'brain' })
    expect(JSON.stringify(fx.sink.events)).not.toContain('a very long reply')
    expect(JSON.stringify(fx.sink.events)).not.toContain('hello')
  })

  it('the person pays: their id is the run\'s gateway identity (llmUserId)', async () => {
    let seen: string | undefined
    const fx = makeFixture({
      engineRun: async (_sessionId, _input, ctx) => {
        seen = ctx.llmUserId
        return 'ok'
      },
    })
    fx.runtime.registerAgent(agentConfig())

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, { person: { id: 'user-7', roles: ['member'] } })
    expect(seen).toBe('user-7')
  })

  it('no person, no run: a dispatch without one fails loud before the engine runs (CB3)', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())
    for (const options of [undefined, {}, { person: { id: '', roles: [] } }]) {
      await expect(
        fx.runtime.dispatch('agent-1', 's', 'hi', undefined, options as never),
      ).rejects.toMatchObject({ code: 'no_person' })
    }
    expect(fx.run).not.toHaveBeenCalled()
    expect(fx.sink.events).toEqual([])
  })

  it('rejects disabled agents with agent_disabled', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig({ enabled: false }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)).rejects.toMatchObject({
      code: 'agent_disabled',
    })
    expect(fx.run).not.toHaveBeenCalled()
  })

  it('rejects unknown agents with unknown_agent', async () => {
    const fx = makeFixture()
    await expect(fx.runtime.dispatch('ghost', 's', 'hi', undefined, asAnn)).rejects.toMatchObject({
      code: 'unknown_agent',
    })
  })

  it('fails loud when the configured engine is not registered', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig({ loopEngine: 'pi' }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)).rejects.toMatchObject({
      code: 'unknown_engine',
    })
    expect(fx.run).not.toHaveBeenCalled()
  })
})

describe('AgentRuntime — edit-and-resend (board a950ef11)', () => {
  it('a dispatch carries its member turn id to the engine', async () => {
    let seen: string | undefined
    const fx = makeFixture({
      engineRun: async (_sessionId, _input, ctx) => {
        seen = ctx.turnId
        return 'ok'
      },
    })
    fx.runtime.registerAgent(agentConfig())
    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, { ...asAnn, turnId: 'm-1' })
    expect(seen).toBe('m-1')
  })

  it('supersedeTurn reaches the engine as the person (their gateway identity and turn ids)', async () => {
    const fx = makeFixture()
    const supersede = vi.fn(async (_s: string, _t: string, _r: string, _ctx: EngineContext) => {})
    fx.engine.supersedeTurn = supersede
    fx.runtime.registerAgent(agentConfig())
    await fx.runtime.supersedeTurn('agent-1', 's', 'm-1', 'm-2', asAnn)
    expect(supersede).toHaveBeenCalledOnce()
    const [sessionId, turnId, replacementTurnId, ctx] = supersede.mock.calls[0]!
    expect([sessionId, turnId, replacementTurnId]).toEqual(['s', 'm-1', 'm-2'])
    expect(ctx.llmUserId).toBe('ann')
    expect(ctx.turnId).toBe('m-2')
  })

  it('an engine that cannot edit turns fails loud; no person, no edit', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())
    await expect(fx.runtime.supersedeTurn('agent-1', 's', 'm-1', 'm-2', asAnn)).rejects.toMatchObject({
      code: 'turn_not_editable',
    })
    await expect(
      fx.runtime.supersedeTurn('agent-1', 's', 'm-1', 'm-2', {} as never),
    ).rejects.toMatchObject({ code: 'no_person' })
  })
})

describe('AgentRuntime — budget', () => {
  it('throws budget_exceeded and emits agent.budget_exceeded when the cap is reached', async () => {
    const fx = makeFixture({ spendFn: () => 5 })
    fx.runtime.registerAgent(agentConfig({ spendCapUsd: 5 }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)).rejects.toMatchObject({
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
      via: 'brain',
    })
    expect(event!.principalId).toBe('ann')
  })

  it('runs uncapped agents and agents below the cap', async () => {
    const fx = makeFixture({ spendFn: () => 1 })
    fx.runtime.registerAgent(agentConfig({ spendCapUsd: 2 }))

    await expect(fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)).resolves.toBe('engine reply')
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

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)
    expect(observed).toBe(1)
  })
})

describe('AgentRuntime — tool surface + execution path (the person\'s rights, never more)', () => {
  const memoryTool = tool('memory.echo', 'memory', ['admin', 'member', 'agent'])
  const ownerTool = tool('email.send_mail', 'email', ['owner'])
  const adminTool = tool('website.publish_page', 'website', ['admin', 'agent'])

  it("toolScope 'all' exposes active-module tools whose roles the PERSON holds — a member gets no admin tool", async () => {
    const fx = makeFixture({
      tools: [memoryTool, ownerTool, adminTool],
      manifests: [modOn('memory'), modOn('email'), modOn('website')],
    })
    await fx.activations.set('memory', true)
    await fx.activations.set('email', true)
    await fx.activations.set('website', true)
    fx.runtime.registerAgent(agentConfig())

    let listed: string[] = []
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      listed = ctx.listTools().map((t) => t.name)
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)
    expect(listed).toEqual(['memory.echo'])
    // The same brain for an admin offers the admin tool too (their rights).
    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, { person: { id: 'boss', roles: ['admin', 'member'] } })
    expect(listed).toEqual(['memory.echo', 'website.publish_page'])
    expect(await fx.runtime.listAgentTools('agent-1', ann)).toEqual([expect.objectContaining({ name: 'memory.echo' })])
  })

  it('toolScope module allowlist restricts the surface even for active, permitted tools', async () => {
    const fx = makeFixture({
      tools: [memoryTool, ownerTool],
      manifests: [modOn('memory'), modOn('email')],
    })
    await fx.activations.set('memory', true)
    await fx.activations.set('email', true)
    fx.runtime.registerAgent(agentConfig({ toolScope: { modules: ['memory'] } }))

    let listed: string[] = []
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      listed = ctx.listTools().map((t) => t.name)
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, { person: { id: 'own', roles: ['owner', 'member'] } })
    expect(listed).toEqual(['memory.echo'])
  })

  it('excludes tools of inactive modules (fail closed) at dispatch time', async () => {
    const fx = makeFixture({
      tools: [memoryTool],
      manifests: [modOn('memory')],
    })
    // memory intentionally left inactive.
    fx.runtime.registerAgent(agentConfig())

    let listed: string[] = ['unset']
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      listed = ctx.listTools().map((t) => t.name)
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)
    expect(listed).toEqual([])
  })

  it('every tool call executes as the person via the brain (delegated principal) through the kernel', async () => {
    const seen: ToolContext[] = []
    const fx = makeFixture({
      tools: [
        tool('memory.echo', 'memory', ['member'], async (ctx, input) => {
          seen.push(ctx)
          return { echoed: input }
        }),
      ],
      manifests: [modOn('memory')],
    })
    await fx.activations.set('memory', true)
    fx.runtime.registerAgent(agentConfig())

    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      expect(ctx.principal).toEqual({ id: 'ann', kind: 'human', roles: ['member'], via: 'brain', agentId: 'agent-1' })
      await ctx.executeTool('memory.echo', { x: 1 })
      return 'done'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)

    expect(seen).toHaveLength(1)
    expect(seen[0]!.principal).toEqual({ id: 'ann', kind: 'human', roles: ['member'], via: 'brain', agentId: 'agent-1' })
    expect(typeof seen[0]!.requestId).toBe('string')
  })

  it('a non-admin cannot execute an admin tool through the brain, even by naming it', async () => {
    let ran = false
    const fx = makeFixture({
      tools: [
        tool('website.publish_page', 'website', ['admin', 'agent'], async () => {
          ran = true
          return {}
        }),
      ],
      manifests: [modOn('website')],
    })
    await fx.activations.set('website', true)
    fx.runtime.registerAgent(agentConfig())
    let refusal: unknown
    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      expect(ctx.listTools()).toEqual([])
      refusal = await ctx.executeTool('website.publish_page', {}).catch((err: unknown) => err)
      return 'done'
    })
    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)
    expect(refusal).toMatchObject({ code: 'permission_denied' })
    expect(ran).toBe(false)
  })

  it('two people dispatching at once never cross principals', async () => {
    const seen: string[] = []
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const fx = makeFixture({
      tools: [
        tool('memory.echo', 'memory', ['member'], async (ctx, input) => {
          seen.push(`${ctx.principal.id}:${(input as { who: string }).who}`)
          return {}
        }),
      ],
      manifests: [modOn('memory')],
    })
    await fx.activations.set('memory', true)
    fx.runtime.registerAgent(agentConfig())
    fx.run.mockImplementation(async (sid: string, _input, ctx: EngineContext) => {
      // Both turns are in flight before either calls its tool.
      if (sid === 'ann-chat') await gate
      else release()
      await ctx.executeTool('memory.echo', { who: sid })
      return `${ctx.principal.id} done`
    })

    const [a, b] = await Promise.all([
      fx.runtime.dispatch('agent-1', 'ann-chat', 'hi', undefined, asAnn),
      fx.runtime.dispatch('agent-1', 'ben-chat', 'hi', undefined, { person: { id: 'ben', roles: ['member'] } }),
    ])
    expect([a, b]).toEqual(['ann done', 'ben done'])
    expect(seen.sort()).toEqual(['ann:ann-chat', 'ben:ben-chat'])
  })

  it('EngineContext.emit defaults the principal to the person + kernel source and reaches the sink', async () => {
    const fx = makeFixture()
    fx.runtime.registerAgent(agentConfig())

    fx.run.mockImplementation(async (_sid, _input, ctx: EngineContext) => {
      await ctx.emit({ type: 'harness.turn_failed', payload: { step: 1 } })
      return 'ok'
    })

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)

    const event = fx.sink.events.find((e) => e.type === 'harness.turn_failed')
    expect(event).toBeDefined()
    expect(event!.principalId).toBe('ann')
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

    await fx.runtime.dispatch('agent-1', 's', 'hi', { stream, surfaceEvent }, asAnn)

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

    await fx.runtime.dispatch('agent-1', 's', 'hi', undefined, asAnn)

    expect(seen?.stream).toBeUndefined()
    expect(seen?.surfaceEvent).toBeUndefined()
  })
})
