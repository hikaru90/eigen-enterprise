import { describe, expect, it, vi } from 'vitest'
import type { AgentConfig } from '$lib/kernel/agent'
import type { EngineContext, EngineSurfaceEvent, EngineToolListing } from '$lib/kernel/engine'
import { KernelError } from '$lib/kernel/errors'
import {
  BuiltinJsonLoop,
  LoopProtocolError,
  MAX_HISTORY_MESSAGES,
  MAX_TOOL_INPUT_SUMMARY_CHARS,
  StreamedAnswerExtractor,
  type LlmCompleteFn,
  type LlmStreamCompleteFn,
} from './builtin-json'

/**
 * Ported 1:1 from modules/orchestrator/brain.spec.ts (the brain became this
 * engine) — assertions kept, harness plumbing (registry/modules) replaced by
 * an injected fake EngineContext.
 */

const agent: AgentConfig = {
  id: 'orchestrator',
  personaName: 'Orchestrator',
  description: 'test agent',
  loopEngine: 'builtin-json',
  toolScope: 'all',
  memoryScope: 'company',
  verificationPolicy: 'none',
  enabled: true,
}

function listing(name: string, summary: string, schema: unknown = { type: 'object' }): EngineToolListing {
  return { name, summary, inputJsonSchema: schema }
}

function gatewayBody(content: string): unknown {
  return { choices: [{ message: { content } }] }
}

type Fixture = {
  engine: BuiltinJsonLoop
  ctx: EngineContext
  executeTool: ReturnType<typeof vi.fn>
  listTools: ReturnType<typeof vi.fn>
  completeCalls: Array<{
    userId: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
  }>
  streamCompleteCalls: number
  deltas: string[]
  surfaceEvents: EngineSurfaceEvent[]
}

function makeFixture(options: {
  responses: string[]
  listings?: EngineToolListing[]
  executeTool?: EngineContext['executeTool']
  stream?: EngineContext['stream']
  surfaceEvent?: EngineContext['surfaceEvent']
  streamComplete?: LlmStreamCompleteFn
}): Fixture {
  const completeCalls: Fixture['completeCalls'] = []
  let index = 0
  const complete: LlmCompleteFn = async (input) => {
    completeCalls.push(input)
    const content = options.responses[index]
    index += 1
    return gatewayBody(content ?? options.responses[options.responses.length - 1])
  }

  const executeTool =
    options.executeTool ??
    vi.fn(async (_name: string, input: unknown) => ({ echoed: input }))
  const listTools = vi.fn(() => options.listings ?? [])

  const deltas: string[] = []
  const streamSink = options.stream
    ? (d: string) => {
        deltas.push(d)
        options.stream!(d)
      }
    : undefined
  const surfaceEvents: EngineSurfaceEvent[] = []
  const surfaceSink = options.surfaceEvent
    ? (e: EngineSurfaceEvent) => {
        surfaceEvents.push(e)
        options.surfaceEvent!(e)
      }
    : undefined

  const ctx: EngineContext = {
    agent,
    principal: { id: agent.id, kind: 'agent', roles: ['admin', 'agent'] },
    executeTool,
    listTools,
    emit: vi.fn(async () => {}),
    spendUsd: () => 0,
    ...(streamSink ? { stream: streamSink } : {}),
    ...(surfaceSink ? { surfaceEvent: surfaceSink } : {}),
  }

  let streamCompleteCalls = 0
  const streamComplete = options.streamComplete
    ? async (input: Parameters<LlmStreamCompleteFn>[0]) => {
        streamCompleteCalls += 1
        return options.streamComplete!(input)
      }
    : undefined

  const engine = new BuiltinJsonLoop({
    complete,
    ...(streamComplete ? { streamComplete } : {}),
  })
  return {
    engine,
    ctx,
    executeTool,
    listTools,
    completeCalls,
    get streamCompleteCalls() {
      return streamCompleteCalls
    },
    deltas,
    surfaceEvents,
  }
}

describe('BuiltinJsonLoop — happy path', () => {
  it('returns the model answer directly when no tool call is needed', async () => {
    const fx = makeFixture({ responses: ['{"answer":"hello there"}'] })

    const reply = await fx.engine.run('session-1', 'hi', fx.ctx)

    expect(reply).toBe('hello there')
    expect(fx.completeCalls).toHaveLength(1)
    expect(fx.completeCalls[0].userId).toBe(agent.id)
    expect(fx.completeCalls[0].temperature).toBe(0)
    const roles = fx.completeCalls[0].messages.map((m) => m.role)
    expect(roles[0]).toBe('system')
    expect(roles.at(-1)).toBe('user')
  })

  it('keeps per-session conversation history across turns', async () => {
    const fx = makeFixture({ responses: ['{"answer":"first"}', '{"answer":"second"}'] })

    await fx.engine.run('session-1', 'one', fx.ctx)
    await fx.engine.run('session-1', 'two', fx.ctx)

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

    await fx.engine.run('session-1', 'for session 1', fx.ctx)
    await fx.engine.run('session-2', 'for session 2', fx.ctx)

    const second = fx.completeCalls[1].messages
    expect(second.map((m) => m.content)).not.toContain('for session 1')
  })

  it('caps the replayed history length', async () => {
    const responses = Array.from({ length: 30 }, (_, i) => `{"answer":"turn ${i}"}`)
    const fx = makeFixture({ responses })
    for (let i = 0; i < 30; i++) {
      await fx.engine.run('session-1', `msg ${i}`, fx.ctx)
    }

    const last = fx.completeCalls.at(-1)
    expect(last).toBeDefined()
    // system + capped history + the new user message.
    expect(last!.messages.length).toBe(1 + MAX_HISTORY_MESSAGES + 1)
  })
})

describe('BuiltinJsonLoop — tool call path', () => {
  it('executes a model tool call via ctx.executeTool and answers after the result', async () => {
    const executeCalls: Array<{ name: string; input: unknown }> = []
    const fx = makeFixture({
      responses: ['{"tool":"testmod.echo","arguments":{"x":1}}', '{"answer":"done with tool"}'],
      listings: [listing('testmod.echo', 'summary of testmod.echo')],
      executeTool: async (name, input) => {
        executeCalls.push({ name, input })
        return { echoed: input }
      },
    })

    const reply = await fx.engine.run('session-1', 'use the tool', fx.ctx)

    expect(reply).toBe('done with tool')
    expect(executeCalls).toEqual([{ name: 'testmod.echo', input: { x: 1 } }])
    // The tool result was fed back to the model before the final answer.
    const lastMessages = fx.completeCalls[1].messages
    expect(lastMessages.some((m) => m.content.includes('Tool result for testmod.echo'))).toBe(true)
  })

  it('routes every tool call of one cycle through ctx.executeTool', async () => {
    const executeTool = vi.fn(async () => ({ ok: true }))
    const fx = makeFixture({
      responses: [
        '{"tool":"testmod.echo","arguments":{}}',
        '{"tool":"testmod.echo","arguments":{}}',
        '{"answer":"ok"}',
      ],
      listings: [listing('testmod.echo', 'summary of testmod.echo')],
      executeTool,
    })

    await fx.engine.run('session-1', 'twice', fx.ctx)

    expect(executeTool).toHaveBeenCalledTimes(2)
    expect(executeTool.mock.calls.every(([name]) => name === 'testmod.echo')).toBe(true)
  })

  it('feeds unknown/hallucinated tool names back to the model instead of failing the cycle', async () => {
    const fx = makeFixture({
      responses: ['{"tool":"testmod.does_not_exist","arguments":{}}', '{"answer":"sorry, adjusted"}'],
      listings: [listing('testmod.echo', 'summary of testmod.echo')],
    })

    const reply = await fx.engine.run('session-1', 'do a thing', fx.ctx)

    expect(reply).toBe('sorry, adjusted')
    expect(fx.completeCalls[1].messages.some((m) => m.content.includes('not available'))).toBe(true)
  })

  it('fails the cycle loud when a tool handler errors with a non-approval error', async () => {
    const fx = makeFixture({
      responses: ['{"tool":"testmod.boom","arguments":{}}'],
      listings: [listing('testmod.boom', 'summary of testmod.boom')],
      executeTool: async () => {
        throw new Error('handler exploded')
      },
    })

    await expect(fx.engine.run('session-1', 'go', fx.ctx)).rejects.toThrow(/handler exploded/)
  })

  it('bubbles KernelErrors from executeTool other than approval_required (loud)', async () => {
    const fx = makeFixture({
      responses: ['{"tool":"testmod.gated","arguments":{}}'],
      listings: [listing('testmod.gated', 'summary of testmod.gated')],
      executeTool: async () => {
        throw new KernelError('permission_denied', 'principal cannot execute testmod.gated')
      },
    })

    await expect(fx.engine.run('session-1', 'go', fx.ctx)).rejects.toMatchObject({
      name: 'KernelError',
      code: 'permission_denied',
    })
  })
})

describe('BuiltinJsonLoop — approval-pending UX', () => {
  it('feeds a structured approval-pending tool result back so the cycle completes', async () => {
    const executeTool = vi.fn(async () => {
      throw new KernelError('approval_required', 'tool testmod.mutate requires approval')
    })
    const fx = makeFixture({
      responses: [
        '{"tool":"testmod.mutate","arguments":{"a":1}}',
        '{"answer":"Your request needs owner approval and is queued."}',
      ],
      listings: [listing('testmod.mutate', 'summary of testmod.mutate')],
      executeTool,
    })

    const reply = await fx.engine.run('session-1', 'mutate please', fx.ctx)

    // The tool never ran — the kernel approval gate stopped it.
    expect(executeTool).toHaveBeenCalledTimes(1)
    expect(reply).toContain('owner approval')
    const feedback = fx.completeCalls[1].messages.at(-1)!.content
    expect(feedback).toContain('approval_pending')
    expect(feedback).toContain('testmod.mutate')
    expect(feedback).toContain('owner approval')
  })
})

describe('BuiltinJsonLoop — tool surface (fail closed)', () => {
  it('receives only the filtered tool surface the harness hands it', async () => {
    const fx = makeFixture({
      responses: ['{"answer":"ok"}'],
      listings: [listing('onmod.tool', 'summary of onmod.tool')],
    })

    await fx.engine.run('session-1', 'hi', fx.ctx)

    // ctx.listTools() is the single source; the engine invents nothing.
    expect(fx.listTools).toHaveBeenCalledTimes(1)
    const system = fx.completeCalls[0].messages[0].content
    expect(system).toContain('onmod.tool')
    expect(system).not.toContain('offmod.tool')
  })

  it('handles an empty tool surface without failing', async () => {
    const fx = makeFixture({ responses: ['{"answer":"ok"}'] })

    const reply = await fx.engine.run('session-1', 'hi', fx.ctx)

    expect(reply).toBe('ok')
    expect(fx.completeCalls[0].messages[0].content).toContain('(no tools are currently available)')
  })

  it('includes tool summaries and JSON schemas in the system prompt', async () => {
    const fx = makeFixture({
      responses: ['{"answer":"ok"}'],
      listings: [
        listing('testmod.typed', 'takes a count', {
          type: 'object',
          properties: { count: { type: 'number' } },
          required: ['count'],
          additionalProperties: false,
        }),
      ],
    })

    await fx.engine.run('session-1', 'hi', fx.ctx)

    const system = fx.completeCalls[0].messages[0].content
    expect(system).toContain('testmod.typed')
    expect(system).toContain('takes a count')
    expect(system).toContain('"type"')
    expect(system).toContain('count')
  })
})

describe('BuiltinJsonLoop — parse failures', () => {
  it('feeds parse errors back and fails loud after repeated failures', async () => {
    const fx = makeFixture({ responses: ['not json at all'] })

    await expect(fx.engine.run('session-1', 'hi', fx.ctx)).rejects.toBeInstanceOf(LoopProtocolError)
    // It retried before giving up.
    expect(fx.completeCalls.length).toBeGreaterThan(1)
  })

  it('honors a custom parseRetry budget', async () => {
    const completeCalls: Fixture['completeCalls'] = []
    const complete: LlmCompleteFn = async (input) => {
      completeCalls.push(input)
      return gatewayBody('not json at all')
    }
    const ctx: EngineContext = {
      agent,
      principal: { id: agent.id, kind: 'agent', roles: ['admin', 'agent'] },
      executeTool: async () => ({}),
      listTools: () => [],
      emit: async () => {},
      spendUsd: () => 0,
    }
    const engine = new BuiltinJsonLoop({ complete, parseRetry: 2 })

    await expect(engine.run('session-1', 'hi', ctx)).rejects.toBeInstanceOf(LoopProtocolError)
    expect(completeCalls).toHaveLength(2)
  })

  it('strips <think> blocks and fenced json from model output', async () => {
    const fx = makeFixture({
      responses: ['<think>hmm</think>```json\n{"answer":"clean"}\n```'],
    })

    const reply = await fx.engine.run('session-1', 'hi', fx.ctx)

    expect(reply).toBe('clean')
  })
})

describe('BuiltinJsonLoop — streaming', () => {
  it('falls back to emitting the full reply as one delta when only ctx.stream is set', async () => {
    const fx = makeFixture({
      responses: ['{"answer":"hello there"}'],
      stream: () => {},
    })

    const reply = await fx.engine.run('session-1', 'hi', fx.ctx)

    expect(reply).toBe('hello there')
    expect(fx.deltas).toEqual(['hello there'])
  })

  it('streams incremental answer deltas when a streaming completion is configured', async () => {
    const fx = makeFixture({
      responses: ['{"answer":"hello world"}'],
      stream: () => {},
      streamComplete: async (input) => {
        // Stream the raw protocol text in chunks; the engine must extract
        // only the answer-string characters.
        for (const chunk of ['{"answ', 'er": "hel', 'lo wo', 'rld"}']) input.onDelta(chunk)
        return gatewayBody('{"answer":"hello world"}')
      },
    })

    const reply = await fx.engine.run('session-1', 'hi', fx.ctx)

    expect(reply).toBe('hello world')
    expect(fx.deltas).toEqual(['hel', 'lo wo', 'rld'])
    expect(fx.streamCompleteCalls).toBe(1)
  })

  it('emits the remainder when the extractor could not stream the full answer', async () => {
    const fx = makeFixture({
      responses: ['{"answer":"handled"}'],
      stream: () => {},
      streamComplete: async (input) => {
        // Streams nothing extractable (e.g. <think> only) — fallback must
        // still deliver the complete answer.
        input.onDelta('<think>hmm</think>')
        return gatewayBody('{"answer":"handled"}')
      },
    })

    const reply = await fx.engine.run('session-1', 'hi', fx.ctx)

    expect(reply).toBe('handled')
    expect(fx.deltas).toEqual(['handled'])
  })

  it('emits no deltas on tool-call turns', async () => {
    const fx = makeFixture({
      responses: ['{"tool":"testmod.echo","arguments":{}}', '{"answer":"done"}'],
      listings: [listing('testmod.echo', 'summary of testmod.echo')],
      stream: () => {},
    })

    await fx.engine.run('session-1', 'use it', fx.ctx)

    expect(fx.deltas).toEqual(['done'])
  })

  it('never breaks when the surface sink throws', async () => {
    const fx = makeFixture({
      responses: ['{"answer":"still replies"}'],
      stream: () => {
        throw new Error('surface exploded')
      },
    })

    await expect(fx.engine.run('session-1', 'hi', fx.ctx)).resolves.toBe('still replies')
  })

  it('never touches the streaming completion without a ctx.stream sink', async () => {
    const fx = makeFixture({
      responses: ['{"answer":"plain"}'],
      streamComplete: async () => {
        throw new Error('streaming completion must not be used')
      },
    })

    const reply = await fx.engine.run('session-1', 'hi', fx.ctx)

    expect(reply).toBe('plain')
    expect(fx.streamCompleteCalls).toBe(0)
    expect(fx.completeCalls).toHaveLength(1)
  })
})

describe('BuiltinJsonLoop — surface events', () => {
  it('emits tool.preview with a short input summary before executeTool', async () => {
    const order: string[] = []
    const fx = makeFixture({
      responses: ['{"tool":"email.send_mail","arguments":{"to":"a@b.c","subject":"Hi"}}', '{"answer":"sent-ish"}'],
      listings: [listing('email.send_mail', 'summary of email.send_mail')],
      executeTool: async () => {
        order.push('execute')
        return { ok: true }
      },
      surfaceEvent: (e) => {
        order.push(e.type)
      },
    })

    await fx.engine.run('session-1', 'send it', fx.ctx)

    expect(fx.surfaceEvents[0]).toEqual({
      type: 'tool.preview',
      tool: 'email.send_mail',
      inputSummary: '{"to":"a@b.c","subject":"Hi"}',
    })
    // Preview lands before the kernel execution.
    expect(order).toEqual(['tool.preview', 'execute'])
  })

  it('truncates long input summaries and reports null for empty arguments', async () => {
    const long = { text: 'x'.repeat(500) }
    const fx = makeFixture({
      responses: [
        JSON.stringify({ tool: 'testmod.echo', arguments: long }),
        JSON.stringify({ tool: 'testmod.echo', arguments: {} }),
        '{"answer":"ok"}',
      ],
      listings: [listing('testmod.echo', 'summary of testmod.echo')],
      surfaceEvent: () => {},
    })

    await fx.engine.run('session-1', 'go', fx.ctx)

    const [preview, emptyPreview] = fx.surfaceEvents
    expect(preview).toMatchObject({ type: 'tool.preview', tool: 'testmod.echo' })
    if (preview.type !== 'tool.preview') throw new Error('unreachable')
    expect(preview.inputSummary!.length).toBeLessThanOrEqual(MAX_TOOL_INPUT_SUMMARY_CHARS)
    expect(preview.inputSummary!.endsWith('…')).toBe(true)
    expect(emptyPreview).toEqual({
      type: 'tool.preview',
      tool: 'testmod.echo',
      inputSummary: null,
    })
  })

  it('emits approval.required when the kernel approval gate stops a tool (result path intact)', async () => {
    const fx = makeFixture({
      responses: [
        '{"tool":"email.send_mail","arguments":{"to":"a@b.c"}}',
        '{"answer":"queued for owner approval"}',
      ],
      listings: [listing('email.send_mail', 'summary of email.send_mail')],
      executeTool: async () => {
        throw new KernelError('approval_required', 'tool email.send_mail requires approval')
      },
      surfaceEvent: () => {},
    })

    const reply = await fx.engine.run('session-1', 'send it', fx.ctx)

    expect(reply).toContain('approval')
    expect(fx.surfaceEvents).toContainEqual({ type: 'approval.required', tool: 'email.send_mail' })
    // Structured tool-result feedback still reaches the model.
    const feedback = fx.completeCalls[1].messages.at(-1)!.content
    expect(feedback).toContain('approval_pending')
  })

  it('never breaks when the surfaceEvent sink throws', async () => {
    const fx = makeFixture({
      responses: ['{"tool":"testmod.echo","arguments":{}}', '{"answer":"ok"}'],
      listings: [listing('testmod.echo', 'summary of testmod.echo')],
      surfaceEvent: () => {
        throw new Error('surface exploded')
      },
    })

    await expect(fx.engine.run('session-1', 'go', fx.ctx)).resolves.toBe('ok')
    expect(fx.executeTool).toHaveBeenCalledTimes(1)
  })
})

describe('StreamedAnswerExtractor', () => {
  it('extracts nothing before the answer key opens and nothing after it closes', () => {
    const ex = new StreamedAnswerExtractor()
    expect(ex.feed('{"tool":"x","arg')).toBe('')
    expect(ex.feed('uments":{"a":1}}')).toBe('')
    expect(ex.emitted).toBe(0)
  })

  it('handles escapes and waits for incomplete ones', () => {
    const ex = new StreamedAnswerExtractor()
    expect(ex.feed('{"answer": "line\\n')).toBe('line\n')
    expect(ex.feed('br')).toBe('br')
    expect(ex.feed('\\u00e9"}')).toBe('é')
    expect(ex.feed('more')).toBe('')
  })

  it('ignores an answer key inside a leading think block', () => {
    const ex = new StreamedAnswerExtractor()
    expect(ex.feed('<think>"answer": "noise</think>{"answer":"real"}')).toBe('real')
  })

  it('stops extracting at the closing quote', () => {
    const ex = new StreamedAnswerExtractor()
    expect(ex.feed('{"answer":"done"} trailing')).toBe('done')
    expect(ex.feed(' garbage')).toBe('')
    expect(ex.emitted).toBe(4)
  })
})
