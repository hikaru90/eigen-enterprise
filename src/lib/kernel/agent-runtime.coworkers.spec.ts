import type { AgentActsAsSelf, AgentConfig, AgentPrincipalContext, AgentTurnContext, CoworkerSource } from './agent'
import type { EngineContext, LoopEngine } from './engine'
import type { ToolContext, ToolDescriptor, ToolPrincipal } from './types'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { AgentRuntime } from './agent-runtime'
import { InMemoryApprovalStore, StaticApprovalPolicy } from './approvals'
import { KernelError } from './errors'
import { InMemoryEventSink } from './events'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from './modules'
import { KernelRegistry } from './registry'

/**
 * AI Co-workers C2 (plan/phase-ai-coworkers.md §5): many agents side by side, each with its own
 * instructions, model and identity. An agent that acts as ITSELF runs under its own principal,
 * pays with its own id, and is capped by the real cost ledger per UTC day.
 */

/** A co-worker's own principal (C1 adds the 'coworker' kind; the runtime is generic over ToolPrincipal). */
const marketing: ToolPrincipal = { id: 'cw-marketing', kind: 'agent', roles: ['member'] }
const gtm: ToolPrincipal = { id: 'cw-gtm', kind: 'agent', roles: ['member'] }

function selfActing(principal: ToolPrincipal, overrides: Partial<AgentActsAsSelf> = {}): AgentActsAsSelf {
  return { kind: 'self', principalFor: () => principal, dailySpendCapUsd: 2, ...overrides }
}

function coworker(id: string, principal: ToolPrincipal, overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id,
    personaName: id,
    description: 'AI co-worker',
    loopEngine: 'durable',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    instructions: (turn) => `You are ${id}. You act as ${turn.principal.id}.`,
    modelId: 'anthropic/claude-sonnet-5.5',
    actsAs: selfActing(principal),
    enabled: true,
    ...overrides,
  }
}

const brainConfig: AgentConfig = {
  id: 'orchestrator',
  personaName: 'Orchestrator',
  description: 'the brain',
  loopEngine: 'durable',
  toolScope: 'all',
  memoryScope: 'company',
  verificationPolicy: 'none',
  instructions: 'engine-default',
  actsAs: 'person',
  enabled: true,
}

const modOn = (id: string): ModuleManifest => ({
  id,
  name: id,
  version: '0.1.0',
  tools: [],
  permissions: { roles: ['admin', 'agent'] },
})

function tool(name: string, module: string, roles: string[], seen: ToolPrincipal[]): ToolDescriptor {
  return {
    name,
    module,
    summary: `summary of ${name}`,
    auditClass: 'read',
    inputSchema: z.looseObject({}),
    permission: { roles },
    handler: async (ctx: ToolContext) => {
      seen.push(ctx.principal)
      return { ok: true }
    },
  }
}

function fixture(options: { spentUsdToday?: (userId: string) => Promise<number>; engineRun?: LoopEngine['run'] } = {}) {
  const activations = new InMemoryActivationStore()
  const modules = new ModuleRegistry(activations)
  modules.register(modOn('memory'))
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
  })
  const seen: ToolPrincipal[] = []
  registry.register(tool('memory.read', 'memory', ['member'], seen))
  registry.register(tool('kernel.admin_only', 'memory', ['admin'], seen))
  const sink = new InMemoryEventSink()
  const contexts: EngineContext[] = []
  const run = vi.fn<LoopEngine['run']>(
    options.engineRun ??
      (async (_sessionId, _input, ctx) => {
        contexts.push(ctx)
        return 'reply'
      }),
  )
  const ledger = vi.fn(options.spentUsdToday ?? (async () => 0))
  const runtime = new AgentRuntime({
    registry,
    isToolActive: (name) => modules.isToolActive(name),
    eventSink: sink,
    spentUsdToday: ledger,
  })
  runtime.registerEngine('durable', { run })
  return { runtime, registry, activations, sink, run, contexts, seen, ledger }
}

async function activeFixture(options: Parameters<typeof fixture>[0] = {}) {
  const fx = fixture(options)
  await fx.activations.set('memory', true)
  return fx
}

describe('AgentRuntime — agents that act as themselves (AI co-workers)', () => {
  it('runs as the agent’s own principal: its id pays, its roles shape the surface, its calls run as it', async () => {
    const principalFor = vi.fn((_ctx: AgentPrincipalContext) => marketing)
    const fx = await activeFixture({
      engineRun: async (_s, _i, ctx) => {
        fx.contexts.push(ctx)
        await ctx.executeTool('memory.read', {})
        return 'done'
      },
    })
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { actsAs: selfActing(marketing, { principalFor }) }))

    const reply = await fx.runtime.dispatchAsAgent('coworker-marketing', 'coworker:mkt:conv-1:root-1', 'hello', undefined, {
      requestedBy: 'ann',
    })

    expect(reply).toBe('done')
    expect(principalFor).toHaveBeenCalledWith({
      agentId: 'coworker-marketing',
      sessionId: 'coworker:mkt:conv-1:root-1',
      requestedBy: 'ann',
    })
    const ctx = fx.contexts[0]!
    expect(ctx.principal).toEqual(marketing)
    expect(ctx.principal.via).toBeUndefined()
    expect(ctx.llmUserId).toBe('cw-marketing')
    expect(ctx.listTools().map((t) => t.name)).toEqual(['memory.read'])
    expect(fx.seen).toEqual([marketing])
  })

  it('emits its harness events under its own id, metadata only', async () => {
    const fx = await activeFixture()
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing))
    await fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'secret words', undefined, { requestedBy: 'ann' })

    const events = fx.sink.events.filter((e) => e.type.startsWith('agent.'))
    expect(events.map((e) => [e.type, e.principalId])).toEqual([
      ['agent.dispatched', 'cw-marketing'],
      ['agent.replied', 'cw-marketing'],
    ])
    expect(events[0]!.payload).toEqual({ agentId: 'coworker-marketing', sessionId: 's-1', actsAs: 'self', requestedBy: 'ann' })
    expect(JSON.stringify(events)).not.toContain('secret words')
  })

  it('hands the engine the instructions it assembled for this turn', async () => {
    const assemble = vi.fn((turn: AgentTurnContext) => `Role card of ${turn.agentId} for ${turn.requestedBy}: ${turn.input}`)
    const fx = await activeFixture()
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { instructions: assemble }))
    fx.runtime.registerAgent(brainConfig)

    await fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'plan the launch', undefined, { requestedBy: 'ann' })
    await fx.runtime.dispatch('orchestrator', 's-2', 'hi', undefined, { person: { id: 'ann', roles: ['member'] } })

    expect(assemble).toHaveBeenCalledWith({
      agentId: 'coworker-marketing',
      sessionId: 's-1',
      principal: marketing,
      input: 'plan the launch',
      requestedBy: 'ann',
    })
    expect(fx.contexts[0]!.instructions).toEqual({ kind: 'own', text: 'Role card of coworker-marketing for ann: plan the launch' })
    // The brain keeps its engine's single prompt.
    expect(fx.contexts[1]!.instructions).toEqual({ kind: 'engine-default' })
  })

  it('empty assembled instructions fail the dispatch loud before the engine runs', async () => {
    const fx = await activeFixture()
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { instructions: () => '  ' }))
    await expect(fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'hi', undefined, {})).rejects.toMatchObject({
      code: 'invalid_instructions',
    })
    expect(fx.run).not.toHaveBeenCalled()
  })

  it('a principal the brain carries is no self principal: fails loud', async () => {
    const fx = await activeFixture()
    const delegated: ToolPrincipal = { id: 'ann', kind: 'human', roles: ['member'], via: 'brain', agentId: 'orchestrator' }
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { actsAs: selfActing(delegated) }))
    await expect(fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'hi', undefined, {})).rejects.toMatchObject({
      code: 'invalid_principal',
    })
    expect(fx.run).not.toHaveBeenCalled()
  })

  it('two co-workers dispatching at once never cross principals, prompts or models', async () => {
    const fx = await activeFixture({
      engineRun: async (_s, _i, ctx) => {
        await new Promise((resolve) => setTimeout(resolve, ctx.principal.id === 'cw-marketing' ? 5 : 0))
        fx.contexts.push(ctx)
        return ctx.principal.id
      },
    })
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing))
    fx.runtime.registerAgent(coworker('coworker-gtm', gtm, { modelId: 'google/gemini-3.8-flash' }))

    const [a, b] = await Promise.all([
      fx.runtime.dispatchAsAgent('coworker-marketing', 's', 'x', undefined, {}),
      fx.runtime.dispatchAsAgent('coworker-gtm', 's', 'x', undefined, {}),
    ])
    expect([a, b]).toEqual(['cw-marketing', 'cw-gtm'])
    const byId = new Map(fx.contexts.map((c) => [c.principal.id, c]))
    expect(byId.get('cw-marketing')).toMatchObject({
      llmUserId: 'cw-marketing',
      agent: { id: 'coworker-marketing', modelId: 'anthropic/claude-sonnet-5.5' },
      instructions: { kind: 'own', text: 'You are coworker-marketing. You act as cw-marketing.' },
    })
    expect(byId.get('cw-gtm')).toMatchObject({
      llmUserId: 'cw-gtm',
      agent: { id: 'coworker-gtm', modelId: 'google/gemini-3.8-flash' },
      instructions: { kind: 'own', text: 'You are coworker-gtm. You act as cw-gtm.' },
    })
  })
})

describe('AgentRuntime — the real spend cap for self-acting agents (cost ledger, UTC day)', () => {
  it('refuses a run once the ledger sum for the agent’s principal reaches its daily cap', async () => {
    const fx = await activeFixture({ spentUsdToday: async (userId) => (userId === 'cw-marketing' ? 2.0001 : 0) })
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { actsAs: selfActing(marketing, { dailySpendCapUsd: 2 }) }))
    fx.runtime.registerAgent(coworker('coworker-gtm', gtm, { actsAs: selfActing(gtm, { dailySpendCapUsd: 2 }) }))

    const refused = fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'hi', undefined, {})
    await expect(refused).rejects.toBeInstanceOf(KernelError)
    await expect(refused).rejects.toMatchObject({ code: 'budget_exceeded' })
    await expect(refused).rejects.toThrow(/coworker-marketing reached its daily spend cap \(2\.0001 >= 2 USD today, UTC\)/)
    expect(fx.run).not.toHaveBeenCalled()
    const exceeded = fx.sink.events.find((e) => e.type === 'agent.budget_exceeded')
    expect(exceeded).toMatchObject({
      principalId: 'cw-marketing',
      payload: { agentId: 'coworker-marketing', sessionId: 's-1', spendUsd: 2.0001, dailySpendCapUsd: 2, actsAs: 'self' },
    })

    // Another co-worker's ledger is its own.
    await expect(fx.runtime.dispatchAsAgent('coworker-gtm', 's-1', 'hi', undefined, {})).resolves.toBe('reply')
    expect(fx.ledger).toHaveBeenCalledWith('cw-gtm')
  })

  it('below the cap it runs, and the engine sees the ledger sum as the agent’s spend', async () => {
    const fx = await activeFixture({ spentUsdToday: async () => 1.25 })
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing))
    await fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'hi', undefined, {})
    expect(fx.contexts[0]!.spendUsd()).toBe(1.25)
  })

  it('reads the ledger fresh on every dispatch (no in-memory accumulator)', async () => {
    let spent = 0
    const fx = await activeFixture({ spentUsdToday: async () => spent })
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { actsAs: selfActing(marketing, { dailySpendCapUsd: 1 }) }))
    await fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'hi', undefined, {})
    spent = 1
    await expect(fx.runtime.dispatchAsAgent('coworker-marketing', 's-1', 'hi', undefined, {})).rejects.toMatchObject({
      code: 'budget_exceeded',
    })
  })

  it('a self-acting agent cannot be registered on a runtime without the ledger', () => {
    const runtime = new AgentRuntime({
      registry: fixture().registry,
      isToolActive: async () => true,
      eventSink: new InMemoryEventSink(),
    })
    expect(() => runtime.registerAgent(coworker('coworker-marketing', marketing))).toThrow(
      expect.objectContaining({ code: 'no_spend_ledger' }),
    )
  })

  it('a self-acting agent carries one cap: the in-memory spendCapUsd next to it fails loud', () => {
    const fx = fixture()
    expect(() => fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { spendCapUsd: 5 }))).toThrow(
      expect.objectContaining({ code: 'invalid_agent' }),
    )
    for (const cap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        fx.runtime.registerAgent(coworker(`coworker-x${cap}`, marketing, { actsAs: selfActing(marketing, { dailySpendCapUsd: cap }) })),
      ).toThrow(expect.objectContaining({ code: 'invalid_agent' }))
    }
  })
})

describe('AgentRuntime — the dispatch entry matches who the agent acts as', () => {
  it('dispatch() refuses a self-acting agent; dispatchAsAgent() refuses a person-acting one', async () => {
    const fx = await activeFixture()
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing))
    fx.runtime.registerAgent(brainConfig)

    await expect(
      fx.runtime.dispatch('coworker-marketing', 's', 'hi', undefined, { person: { id: 'ann', roles: ['member'] } }),
    ).rejects.toMatchObject({ code: 'agent_acts_as_itself' })
    await expect(fx.runtime.dispatchAsAgent('orchestrator', 's', 'hi', undefined, {})).rejects.toMatchObject({
      code: 'agent_acts_as_person',
    })
    await expect(
      fx.runtime.supersedeTurn('coworker-marketing', 's', 't1', 't2', { person: { id: 'ann', roles: ['member'] } }),
    ).rejects.toMatchObject({ code: 'agent_acts_as_itself' })
    await expect(fx.runtime.listAgentTools('coworker-marketing', { id: 'ann', roles: ['member'] })).rejects.toMatchObject({
      code: 'agent_acts_as_itself',
    })
    expect(fx.run).not.toHaveBeenCalled()
  })

  it('a disabled or unknown self-acting agent fails loud', async () => {
    const fx = await activeFixture()
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, { enabled: false }))
    await expect(fx.runtime.dispatchAsAgent('coworker-marketing', 's', 'hi', undefined, {})).rejects.toMatchObject({
      code: 'agent_disabled',
    })
    await expect(fx.runtime.dispatchAsAgent('ghost', 's', 'hi', undefined, {})).rejects.toMatchObject({ code: 'unknown_agent' })
  })
})

describe('AgentRuntime — registering many agents (register / replace / unregister / load from a source)', () => {
  it('replaceAgent swaps a registered config (next dispatch uses it); unknown ids fail loud', async () => {
    const fx = await activeFixture()
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing))
    fx.runtime.replaceAgent(coworker('coworker-marketing', marketing, { modelId: 'qwen/qwen3.8-flash' }))
    await fx.runtime.dispatchAsAgent('coworker-marketing', 's', 'hi', undefined, {})
    expect(fx.contexts[0]!.agent.modelId).toBe('qwen/qwen3.8-flash')
    expect(() => fx.runtime.replaceAgent(coworker('ghost', marketing))).toThrow(expect.objectContaining({ code: 'unknown_agent' }))
  })

  it('an agent id never holds ":" — the conversation key `<agentId>:<sessionId>` splits at its first colon', () => {
    const fx = fixture()
    expect(() => fx.runtime.registerAgent(coworker('coworker:marketing', marketing))).toThrow(
      expect.objectContaining({ code: 'invalid_agent' }),
    )
    expect(() => fx.runtime.registerAgent({ ...brainConfig, id: ' ' })).toThrow(expect.objectContaining({ code: 'invalid_agent' }))
  })

  it('unregisterAgent removes an agent; unknown ids fail loud', async () => {
    const fx = fixture()
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing))
    fx.runtime.unregisterAgent('coworker-marketing')
    expect(fx.runtime.getAgent('coworker-marketing')).toBeUndefined()
    expect(() => fx.runtime.unregisterAgent('coworker-marketing')).toThrow(expect.objectContaining({ code: 'unknown_agent' }))
  })

  it('loadAgents keeps exactly the source’s set registered: adds, replaces, removes — and never touches other agents', async () => {
    const fx = fixture()
    fx.runtime.registerAgent(brainConfig)
    let configs = [coworker('coworker-marketing', marketing), coworker('coworker-gtm', gtm)]
    const source: CoworkerSource = { listAgentConfigs: async () => configs }

    expect(await fx.runtime.loadAgents(source)).toEqual({
      registered: ['coworker-gtm', 'coworker-marketing'],
      replaced: [],
      unregistered: [],
    })
    configs = [
      coworker('coworker-marketing', marketing, { modelId: 'mistralai/mistral-large-4-0' }),
      coworker('coworker-designer', { id: 'cw-designer', kind: 'agent', roles: ['member'] }),
    ]
    expect(await fx.runtime.loadAgents(source)).toEqual({
      registered: ['coworker-designer'],
      replaced: ['coworker-marketing'],
      unregistered: ['coworker-gtm'],
    })
    expect(fx.runtime.listAgents().map((a) => a.id)).toEqual(['coworker-designer', 'coworker-marketing', 'orchestrator'])
    expect(fx.runtime.getAgent('coworker-marketing')?.modelId).toBe('mistralai/mistral-large-4-0')
  })

  it('a source cannot take over an agent registered another way (the brain): fails loud, nothing changes', async () => {
    const fx = fixture()
    fx.runtime.registerAgent(brainConfig)
    const source: CoworkerSource = {
      listAgentConfigs: async () => [coworker('coworker-marketing', marketing), { ...brainConfig, personaName: 'Impostor' }],
    }
    await expect(fx.runtime.loadAgents(source)).rejects.toMatchObject({ code: 'duplicate_agent' })
    expect(fx.runtime.getAgent('orchestrator')?.personaName).toBe('Orchestrator')
    expect(fx.runtime.getAgent('coworker-marketing')).toBeUndefined()
  })

  it('a source listing one id twice fails loud', async () => {
    const fx = fixture()
    const source: CoworkerSource = {
      listAgentConfigs: async () => [coworker('coworker-marketing', marketing), coworker('coworker-marketing', marketing)],
    }
    await expect(fx.runtime.loadAgents(source)).rejects.toMatchObject({ code: 'duplicate_agent' })
    expect(fx.runtime.listAgents()).toEqual([])
  })

  it('describeAgents is the serializable view: no functions, who it acts as, whose prompt', () => {
    const fx = fixture()
    fx.runtime.registerAgent(brainConfig)
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing))
    const summaries = fx.runtime.describeAgents()
    expect(summaries).toEqual([
      expect.objectContaining({
        id: 'coworker-marketing',
        instructions: 'own',
        actsAs: 'self',
        dailySpendCapUsd: 2,
        modelId: 'anthropic/claude-sonnet-5.5',
      }),
      expect.objectContaining({ id: 'orchestrator', instructions: 'engine-default', actsAs: 'person' }),
    ])
    expect(JSON.parse(JSON.stringify(summaries))).toEqual(summaries)
  })
})
