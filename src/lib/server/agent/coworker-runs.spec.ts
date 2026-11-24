import type { GatewayCompleteFn } from './gateway-model'
import type { AgentConfig } from '$lib/kernel/agent'
import type { ToolContext, ToolPrincipal } from '$lib/kernel/types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { AgentRuntime } from '$lib/kernel/agent-runtime'
import { InMemoryApprovalStore, StaticApprovalPolicy } from '$lib/kernel/approvals'
import { DurableLoopEngine } from '$lib/kernel/engines/durable'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import { ModelNotInPoolError } from '$lib/server/llm/model-pool'
import { DEFAULT_MOCK_TOOL, MOCK_ANSWER, mockChatCompletion } from '../../../../scripts/mock-gateway-chat.mjs'
import { InMemoryDurableConversationIndex } from './conversation-index'
import { getDurableHarness, resetDurableHarnessSingletonForTests, type ResumedChatTurn } from './durable-harness'

/**
 * AI Co-workers C2 (plan/phase-ai-coworkers.md §8): two agents side by side, each with its own
 * instructions and its own model, through the real durable engine (pi-durable on a temp SQLite
 * file) and the mock gateway's chat behaviour (scripts/mock-gateway-chat.mjs, what the e2e
 * harness serves on :5199). Never a real LLM. Each gateway request must carry its own system
 * prompt, its own model and its own billing identity; a model outside the pool fails loud.
 */

const BRAIN_PROMPT = 'You are the company brain.'

type SeenRequest = { userId: string; modelOverride: string | undefined; system: string; tools: string[] }

/** The gateway seam answered by the mock gateway, recording what each request carried. */
function mockGateway() {
  const seen: SeenRequest[] = []
  const complete: GatewayCompleteFn = async (input) => {
    const system = input.messages.find((m) => m.role === 'system')?.content ?? ''
    const tools = (input.tools ?? []).map((t) => (t as { function: { name: string } }).function.name)
    seen.push({ userId: input.userId, modelOverride: input.modelOverride, system, tools })
    // What the gateway sends upstream: the override, else the company's chat slot.
    const body = { model: input.modelOverride ?? 'company-chat-slot', messages: input.messages, tools: input.tools }
    return mockChatCompletion(body, {}).response
  }
  return { complete, seen }
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ee-coworkers-'))
  resetDurableHarnessSingletonForTests()
})

afterEach(() => {
  resetDurableHarnessSingletonForTests()
  rmSync(dir, { recursive: true, force: true })
})

const marketing: ToolPrincipal = { id: 'cw-marketing', kind: 'agent', roles: ['member'] }
const gtm: ToolPrincipal = { id: 'cw-gtm', kind: 'agent', roles: ['member'] }

function coworker(id: string, principal: ToolPrincipal, prompt: (input: string) => string, modelId: string): AgentConfig {
  return {
    id,
    personaName: id,
    description: 'AI co-worker',
    loopEngine: 'durable',
    toolScope: 'all',
    memoryScope: 'company',
    verificationPolicy: 'none',
    instructions: (turn) => prompt(turn.input),
    modelId,
    actsAs: { kind: 'self', principalFor: () => principal, dailySpendCapUsd: 5 },
    enabled: true,
  }
}

async function fixture() {
  const { complete, seen } = mockGateway()
  const index = new InMemoryDurableConversationIndex()
  const deps = {
    env: { EE_AGENT_STATE_DIR: dir },
    index,
    complete,
    onReport: () => {},
    runAsPrincipal: async () => {
      throw new Error('no background runs here')
    },
    mirrorResumedChatTurn: async (turn: ResumedChatTurn) => {
      throw new Error(`unexpected chat mirror of ${turn.conversationKey}`)
    },
  }
  const engine = new DurableLoopEngine({
    harness: {
      conversation: async (input) => (await getDurableHarness(deps)).engineHarness.conversation(input),
      startBackgroundRun: async (input) => (await getDurableHarness(deps)).engineHarness.startBackgroundRun(input),
    },
    instructions: BRAIN_PROMPT,
  })

  const activations = new InMemoryActivationStore()
  const modules = new ModuleRegistry(activations)
  modules.register({ id: 'website', name: 'website', version: '0.1.0', tools: [], permissions: { roles: ['admin', 'agent'] } })
  await activations.set('website', true)
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new StaticApprovalPolicy(new Set()),
    approvalStore: new InMemoryApprovalStore(),
  })
  const toolCalls: ToolPrincipal[] = []
  registry.register({
    name: DEFAULT_MOCK_TOOL,
    module: 'website',
    summary: 'List the website pages',
    auditClass: 'read',
    inputSchema: z.looseObject({}),
    permission: { roles: ['member'] },
    handler: async (ctx: ToolContext) => {
      toolCalls.push(ctx.principal)
      return { pages: [] }
    },
  })
  const runtime = new AgentRuntime({
    registry,
    isToolActive: (name) => modules.isToolActive(name),
    eventSink: new InMemoryEventSink(),
    engines: new Map([['durable', engine]]),
    spentUsdToday: async () => 0,
  })
  return { runtime, seen, index, toolCalls }
}

describe('two co-workers through the durable engine and the mock gateway', () => {
  it('each request carries its own system prompt, its own model and its own billing identity', async () => {
    const fx = await fixture()
    fx.runtime.registerAgent(
      coworker('coworker-marketing', marketing, (input) => `ROLE: Marketing Manager. Trigger: ${input}`, 'anthropic/claude-sonnet-5.5'),
    )
    fx.runtime.registerAgent(
      coworker('coworker-gtm', gtm, (input) => `ROLE: Go-to-Market Manager. Trigger: ${input}`, 'google/gemini-3.8-flash'),
    )

    const thread = 'coworker:%s:conv-1:root-1'
    const [a, b] = await Promise.all([
      fx.runtime.dispatchAsAgent('coworker-marketing', thread.replace('%s', 'cw-marketing'), 'plan the launch', undefined, {
        requestedBy: 'ann',
      }),
      fx.runtime.dispatchAsAgent('coworker-gtm', thread.replace('%s', 'cw-gtm'), 'price the launch', undefined, {
        requestedBy: 'cw-marketing',
      }),
    ])
    expect([a, b]).toEqual([MOCK_ANSWER, MOCK_ANSWER])

    const byUser = (userId: string) => fx.seen.filter((r) => r.userId === userId)
    // Tool call first, then the answer: two model calls per co-worker, each its own.
    expect(byUser('cw-marketing')).toHaveLength(2)
    expect(byUser('cw-gtm')).toHaveLength(2)
    for (const request of byUser('cw-marketing')) {
      expect(request.modelOverride).toBe('anthropic/claude-sonnet-5.5')
      expect(request.system).toContain('ROLE: Marketing Manager. Trigger: plan the launch')
      expect(request.system).not.toContain(BRAIN_PROMPT)
      expect(request.tools).toContain(DEFAULT_MOCK_TOOL.replace(/\./g, '__'))
    }
    for (const request of byUser('cw-gtm')) {
      expect(request.modelOverride).toBe('google/gemini-3.8-flash')
      expect(request.system).toContain('ROLE: Go-to-Market Manager. Trigger: price the launch')
      expect(request.system).not.toContain('Marketing Manager')
    }
    // The mock's tool call ran through the kernel as each co-worker itself.
    expect(fx.toolCalls.map((p) => p.id).sort()).toEqual(['cw-gtm', 'cw-marketing'])
    expect(fx.toolCalls.every((p) => p.via === undefined)).toBe(true)

    // One durable conversation per (co-worker, thread), billed to the co-worker.
    const rows = await fx.index.listConversations()
    expect(rows.map((r) => [r.conversationKey, r.llmUserId]).sort()).toEqual([
      ['coworker-gtm:coworker:cw-gtm:conv-1:root-1', 'cw-gtm'],
      ['coworker-marketing:coworker:cw-marketing:conv-1:root-1', 'cw-marketing'],
    ])
  })

  it('a co-worker’s prompt is assembled per turn, and a changed model takes effect on its next turn', async () => {
    const fx = await fixture()
    let lens = 'growth first'
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, () => `Lens: ${lens}`, 'anthropic/claude-sonnet-5.5'))
    const session = 'coworker:cw-marketing:conv-1:root-1'

    await fx.runtime.dispatchAsAgent('coworker-marketing', session, '[mock-tool:none] first', undefined, {})
    lens = 'brand first'
    fx.runtime.replaceAgent(coworker('coworker-marketing', marketing, () => `Lens: ${lens}`, 'qwen/qwen3.8-flash'))
    await fx.runtime.dispatchAsAgent('coworker-marketing', session, '[mock-tool:none] second', undefined, {})

    expect(fx.seen.map((r) => [r.modelOverride, r.system])).toEqual([
      ['anthropic/claude-sonnet-5.5', expect.stringContaining('Lens: growth first')],
      ['qwen/qwen3.8-flash', expect.stringContaining('Lens: brand first')],
    ])
    expect(fx.seen[1]!.system).not.toContain('growth first')
    expect(await fx.index.listConversations()).toHaveLength(1)
  })

  it('the brain next to them keeps its engine prompt and the company chat slot (no model override)', async () => {
    const fx = await fixture()
    fx.runtime.registerAgent({
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
    })
    fx.runtime.registerAgent(coworker('coworker-marketing', marketing, () => 'ROLE: Marketing Manager.', 'anthropic/claude-sonnet-5.5'))

    await fx.runtime.dispatch('orchestrator', 'chat-1', '[mock-tool:none] hi', undefined, { person: { id: 'ann', roles: ['member'] } })
    await fx.runtime.dispatchAsAgent('coworker-marketing', 'coworker:cw-marketing:c:r', '[mock-tool:none] hi', undefined, {})

    expect(fx.seen).toEqual([
      expect.objectContaining({ userId: 'ann', modelOverride: undefined, system: expect.stringContaining(BRAIN_PROMPT) }),
      expect.objectContaining({ userId: 'cw-marketing', modelOverride: 'anthropic/claude-sonnet-5.5' }),
    ])
    expect(fx.seen[1]!.system).not.toContain(BRAIN_PROMPT)
  })

  it('a model outside the pool fails loud before any model call or conversation', async () => {
    const fx = await fixture()
    fx.runtime.registerAgent(coworker('coworker-rogue', marketing, () => 'ROLE: Rogue.', 'vendor/unvetted-model'))
    const run = fx.runtime.dispatchAsAgent('coworker-rogue', 'coworker:cw-marketing:c:r', 'hi', undefined, {})
    await expect(run).rejects.toBeInstanceOf(ModelNotInPoolError)
    await expect(run).rejects.toThrow(/"vendor\/unvetted-model" is not in the model pool for the chat slot/)
    expect(fx.seen).toEqual([])
    expect(await fx.index.listConversations()).toEqual([])
  })
})
