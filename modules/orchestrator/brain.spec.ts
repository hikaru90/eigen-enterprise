import type { TelegramSessionRef } from '../chat-gateway/telegram'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { StaticApprovalPolicy, InMemoryApprovalStore } from '$lib/kernel/approvals'
import { InMemoryEventSink } from '$lib/kernel/events'
import { InMemoryActivationStore, ModuleRegistry, type ModuleManifest } from '$lib/kernel/modules'
import { KernelRegistry } from '$lib/kernel/registry'
import type { ToolDescriptor, ToolContext } from '$lib/kernel/types'
import {
  MAX_HISTORY_MESSAGES,
  ORCHESTRATOR_LLM_USER_ID,
  ORCHESTRATOR_PRINCIPAL,
  OrchestratorBrain,
  OrchestratorBrainError,
  type LlmCompleteFn,
} from './brain'

const session: TelegramSessionRef = {
  sessionId: 'session-1',
  platform: 'telegram',
  externalChatId: '100',
  principalId: 'principal-1',
}

function gatewayBody(content: string): unknown {
  return { choices: [{ message: { content } }] }
}

function simpleTool(
  name: string,
  roles: string[],
  auditClass: ToolDescriptor['auditClass'],
  handler: (ctx: ToolContext, input: unknown) => Promise<unknown>,
  manifestId = 'testmod',
): ToolDescriptor {
  return {
    name,
    module: manifestId,
    summary: `summary of ${name}`,
    auditClass,
    inputSchema: z.looseObject({}),
    permission: { roles },
    handler,
  }
}

function echoHandler() {
  return async (_ctx: ToolContext, input: unknown) => ({ echoed: input })
}

type Fixture = {
  brain: OrchestratorBrain
  registry: KernelRegistry
  modules: ModuleRegistry
  activations: InMemoryActivationStore
  completeCalls: Array<{
    userId: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
  }>
}

function makeFixture(options: {
  responses: string[]
  tools?: ToolDescriptor[]
  manifests?: ModuleManifest[]
  approvalTools?: ReadonlySet<string>
}): Fixture {
  const activations = new InMemoryActivationStore()
  const modules = new ModuleRegistry(activations)
  for (const manifest of options.manifests ?? []) modules.register(manifest)
  const registry = new KernelRegistry({
    eventSink: new InMemoryEventSink(),
    approvalPolicy: new StaticApprovalPolicy(options.approvalTools ?? new Set()),
    approvalStore: new InMemoryApprovalStore(),
  })
  for (const tool of options.tools ?? []) registry.register(tool)

  const completeCalls: Fixture['completeCalls'] = []
  let index = 0
  const complete: LlmCompleteFn = async (input) => {
    completeCalls.push(input)
    const content = options.responses[index]
    index += 1
    return gatewayBody(content ?? options.responses[options.responses.length - 1])
  }

  const brain = new OrchestratorBrain({ registry, modules, complete })
  return { brain, registry, modules, activations, completeCalls }
}

const modOn = (id: string): ModuleManifest => ({
  id,
  name: id,
  version: '0.1.0',
  tools: [],
  permissions: { roles: ['admin', 'agent'] },
})

describe('OrchestratorBrain — happy path', () => {
  it('returns the model answer directly when no tool call is needed', async () => {
    const fx = makeFixture({ responses: ['{"answer":"hello there"}'] })

    const reply = await fx.brain.respond(session, 'hi')

    expect(reply).toBe('hello there')
    expect(fx.completeCalls).toHaveLength(1)
    expect(fx.completeCalls[0].userId).toBe(ORCHESTRATOR_LLM_USER_ID)
    expect(fx.completeCalls[0].temperature).toBe(0)
    const roles = fx.completeCalls[0].messages.map((m) => m.role)
    expect(roles[0]).toBe('system')
    expect(roles.at(-1)).toBe('user')
  })

  it('keeps per-session conversation history across turns', async () => {
    const fx = makeFixture({ responses: ['{"answer":"first"}', '{"answer":"second"}'] })

    await fx.brain.respond(session, 'one')
    await fx.brain.respond(session, 'two')

    const secondCall = fx.completeCalls[1]
    const contents = secondCall.messages.map((m) => m.content)
    expect(secondCall.messages.filter((m) => m.role === 'user')).toHaveLength(2)
    expect(contents).toContain('one')
    expect(contents).toContain('two')
    expect(secondCall.messages.filter((m) => m.role === 'assistant').map((m) => m.content)).toEqual([
      'first',
    ])
  })

  it('separates conversation history by session id', async () => {
    const fx = makeFixture({ responses: ['{"answer":"a"}', '{"answer":"b"}'] })

    await fx.brain.respond(session, 'for session 1')
    await fx.brain.respond({ ...session, sessionId: 'session-2' }, 'for session 2')

    const second = fx.completeCalls[1].messages
    expect(second.map((m) => m.content)).not.toContain('for session 1')
  })

  it('caps the replayed history length', async () => {
    const responses = Array.from({ length: 30 }, (_, i) => `{"answer":"turn ${i}"}`)
    const fx = makeFixture({ responses })
    for (let i = 0; i < 30; i++) {
      await fx.brain.respond(session, `msg ${i}`)
    }

    const last = fx.completeCalls.at(-1)
    expect(last).toBeDefined()
    // system + capped history + the new user message.
    expect(last!.messages.length).toBe(1 + MAX_HISTORY_MESSAGES + 1)
  })
})

describe('OrchestratorBrain — tool call path', () => {
  it('executes a model tool call via the kernel registry and answers after the result', async () => {
    const executeCalls: Array<{ name: string; input: unknown }> = []
    const tool = simpleTool('testmod.echo', ['admin', 'agent'], 'read', async (ctx, input) => {
      executeCalls.push({ name: 'testmod.echo', input })
      expect(ctx.principal).toEqual(ORCHESTRATOR_PRINCIPAL)
      expect(typeof ctx.requestId).toBe('string')
      return { echoed: input }
    })
    const fx = makeFixture({
      responses: ['{"tool":"testmod.echo","arguments":{"x":1}}', '{"answer":"done with tool"}'],
      tools: [tool],
      manifests: [modOn('testmod')],
    })
    await fx.activations.set('testmod', true)

    const reply = await fx.brain.respond(session, 'use the tool')

    expect(reply).toBe('done with tool')
    expect(executeCalls).toEqual([{ name: 'testmod.echo', input: { x: 1 } }])
    // The tool result was fed back to the model before the final answer.
    const lastMessages = fx.completeCalls[1].messages
    expect(lastMessages.some((m) => m.content.includes('Tool result for testmod.echo'))).toBe(true)
  })

  it('runs every tool call of one cycle under the orchestrator principal and one requestId', async () => {
    const seen: ToolContext[] = []
    const tool = simpleTool('testmod.echo', ['admin', 'agent'], 'read', async (ctx) => {
      seen.push(ctx)
      return { ok: true }
    })
    const fx = makeFixture({
      responses: [
        '{"tool":"testmod.echo","arguments":{}}',
        '{"tool":"testmod.echo","arguments":{}}',
        '{"answer":"ok"}',
      ],
      tools: [tool],
      manifests: [modOn('testmod')],
    })
    await fx.activations.set('testmod', true)

    await fx.brain.respond(session, 'twice')

    expect(seen).toHaveLength(2)
    expect(seen[0].requestId).toBe(seen[1].requestId)
    expect(seen[0].principal.id).toBe('orchestrator')
    expect(seen[0].principal.kind).toBe('agent')
    expect(seen[0].principal.roles).toEqual(['admin', 'agent'])
  })

  it('feeds unknown/hallucinated tool names back to the model instead of failing the cycle', async () => {
    const fx = makeFixture({
      responses: ['{"tool":"testmod.does_not_exist","arguments":{}}', '{"answer":"sorry, adjusted"}'],
      manifests: [modOn('testmod')],
    })
    await fx.activations.set('testmod', true)

    const reply = await fx.brain.respond(session, 'do a thing')

    expect(reply).toBe('sorry, adjusted')
    expect(fx.completeCalls[1].messages.some((m) => m.content.includes('not available'))).toBe(true)
  })

  it('fails the cycle loud when a tool handler errors with a non-approval error', async () => {
    const tool = simpleTool('testmod.boom', ['admin', 'agent'], 'read', async () => {
      throw new Error('handler exploded')
    })
    const fx = makeFixture({
      responses: ['{"tool":"testmod.boom","arguments":{}}'],
      tools: [tool],
      manifests: [modOn('testmod')],
    })
    await fx.activations.set('testmod', true)

    await expect(fx.brain.respond(session, 'go')).rejects.toThrow(/handler exploded/)
  })
})

describe('OrchestratorBrain — approval-pending UX', () => {
  it('feeds a structured approval-pending tool result back so the cycle completes', async () => {
    const handler = vi.fn(echoHandler())
    const tool = simpleTool('testmod.mutate', ['admin', 'agent'], 'mutate', handler)
    const fx = makeFixture({
      responses: [
        '{"tool":"testmod.mutate","arguments":{"a":1}}',
        '{"answer":"Your request needs owner approval and is queued."}',
      ],
      tools: [tool],
      manifests: [modOn('testmod')],
      approvalTools: new Set(['testmod.mutate']),
    })
    await fx.activations.set('testmod', true)

    const reply = await fx.brain.respond(session, 'mutate please')

    // Handler never ran — the kernel approval gate stopped it.
    expect(handler).not.toHaveBeenCalled()
    expect(reply).toContain('owner approval')
    const feedback = fx.completeCalls[1].messages.at(-1)!.content
    expect(feedback).toContain('approval_pending')
    expect(feedback).toContain('testmod.mutate')
    expect(feedback).toContain('owner approval')
  })
})

describe('OrchestratorBrain — tool surface (fail closed)', () => {
  it('offers only tools of ACTIVATED modules to the model', async () => {
    const onTool = simpleTool('onmod.tool', ['admin', 'agent'], 'read', echoHandler(), 'onmod')
    const offTool = simpleTool('offmod.tool', ['admin', 'agent'], 'read', echoHandler(), 'offmod')
    const fx = makeFixture({
      responses: ['{"answer":"ok"}'],
      tools: [onTool, offTool],
      manifests: [modOn('onmod'), modOn('offmod')],
    })
    await fx.activations.set('onmod', true)
    // offmod intentionally left inactive.

    await fx.brain.respond(session, 'hi')

    const system = fx.completeCalls[0].messages[0].content
    expect(system).toContain('onmod.tool')
    expect(system).not.toContain('offmod.tool')
  })

  it('does not offer tools whose roles the orchestrator principal lacks', async () => {
    const ownerTool = simpleTool('testmod.owneronly', ['owner'], 'read', echoHandler())
    const fx = makeFixture({
      responses: ['{"answer":"ok"}'],
      tools: [ownerTool],
      manifests: [modOn('testmod')],
    })
    await fx.activations.set('testmod', true)

    await fx.brain.respond(session, 'hi')

    expect(fx.completeCalls[0].messages[0].content).not.toContain('testmod.owneronly')
  })

  it('includes tool summaries and zod-derived JSON schemas in the system prompt', async () => {
    const tool: ToolDescriptor = {
      name: 'testmod.typed',
      module: 'testmod',
      summary: 'takes a count',
      auditClass: 'read',
      inputSchema: z.object({ count: z.number().int() }),
      permission: { roles: ['admin', 'agent'] },
      handler: echoHandler(),
    }
    const fx = makeFixture({
      responses: ['{"answer":"ok"}'],
      tools: [tool],
      manifests: [modOn('testmod')],
    })
    await fx.activations.set('testmod', true)

    await fx.brain.respond(session, 'hi')

    const system = fx.completeCalls[0].messages[0].content
    expect(system).toContain('testmod.typed')
    expect(system).toContain('takes a count')
    expect(system).toContain('"type"')
    expect(system).toContain('count')
  })
})

describe('OrchestratorBrain — parse failures', () => {
  it('feeds parse errors back and fails loud after repeated failures', async () => {
    const fx = makeFixture({ responses: ['not json at all'] })

    await expect(fx.brain.respond(session, 'hi')).rejects.toBeInstanceOf(OrchestratorBrainError)
    // It retried before giving up.
    expect(fx.completeCalls.length).toBeGreaterThan(1)
  })

  it('strips <think> blocks and fenced json from model output', async () => {
    const fx = makeFixture({
      responses: ['<think>hmm</think>```json\n{"answer":"clean"}\n```'],
    })

    const reply = await fx.brain.respond(session, 'hi')

    expect(reply).toBe('clean')
  })
})
