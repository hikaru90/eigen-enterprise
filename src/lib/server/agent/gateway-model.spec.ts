import type { PiTool, TranscriptContext } from './pi-durable'
import { describe, expect, it } from 'vitest'
import {
  assistantMessageFromGatewayResponse,
  buildToolNameCodec,
  createGatewayProviderApi,
  gatewayModelDescriptor,
  toOpenAiMessages,
} from './gateway-model'

const model = gatewayModelDescriptor()
const WIRE_NAME_RE = /^[a-zA-Z0-9_-]{1,64}$/

function makeTool(name: string, description = `Tool ${name}`): PiTool {
  return {
    name,
    description,
    parameters: { type: 'object', properties: {} },
  } as unknown as PiTool
}

describe('the gateway provider stream', () => {
  it('an aborted request (the conversation was stopped) ends at once as aborted, without waiting for the gateway', async () => {
    const api = createGatewayProviderApi({
      complete: () => new Promise(() => {}), // the gateway never answers
      resolveCall: async () => ({ userId: 'alice', task: 'assistant.turn' }),
    })
    const ac = new AbortController()
    const events = api.stream(model, { messages: [] } as never, { sessionId: 's', signal: ac.signal } as never)
    ac.abort()
    const message = await events.result()
    expect(message.stopReason).toBe('aborted')
  })

  it('encodes dotted tool names on the wire and decodes tool calls back to original kernel names', async () => {
    let seenTools: string[] = []
    const api = createGatewayProviderApi({
      resolveCall: async () => ({ userId: 'alice', task: 'assistant.turn' }),
      complete: async (input) => {
        seenTools = (input.tools ?? []).map((t) => (t as { function: { name: string } }).function.name)
        return {
          choices: [
            {
              message: {
                role: 'assistant',
                content: '',
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: { name: 'messages__post', arguments: '{"body":"hello"}' },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 5, completion_tokens: 3 },
        }
      },
    })

    const gpt5Model = gatewayModelDescriptor('openai/gpt-5-mini')
    const context = {
      messages: [
        {
          role: 'system',
          content: 'You are a co-worker.',
          toolsAdded: [makeTool('ee'), makeTool('messages.post')],
          timestamp: 0,
        },
        { role: 'user', content: 'Say hi', timestamp: 1 },
      ],
    } as unknown as TranscriptContext

    const events = api.stream(gpt5Model, context, { sessionId: 's1' } as never)
    const message = await events.result()

    expect(seenTools).toEqual(['ee', 'messages__post'])
    expect(message.stopReason).toBe('toolUse')
    expect(message.content).toEqual([
      { type: 'toolCall', id: 'c1', name: 'messages.post', arguments: { body: 'hello' } },
    ])
  })

  it('caps tools at 128 for openai/gpt-5-mini with ee first and priority namespaces preserved, while DeepSeek receives all tools', async () => {
    const priorityNames = [
      'messages.post',
      'drive.list_files',
      'tasks.assign',
      'memory.search',
      'coworkers.list',
      'org.chart',
      'contacts.list',
      'email.send',
      'calendar.list_events',
    ]
    const extraTools = Array.from({ length: 150 }, (_, i) => makeTool(`extra.tool_${i}`))
    const allTools = [...extraTools, ...priorityNames.map((n) => makeTool(n)), makeTool('ee')]
    expect(allTools).toHaveLength(160)

    const context = {
      messages: [
        {
          role: 'system',
          content: 'You are a co-worker.',
          toolsAdded: allTools,
          timestamp: 0,
        },
        { role: 'user', content: 'Check tasks', timestamp: 1 },
      ],
    } as unknown as TranscriptContext

    let gptTools: string[] = []
    let gptSystem = ''
    let deepseekTools: string[] = []
    let deepseekSystem = ''

    const api = createGatewayProviderApi({
      resolveCall: async () => ({ userId: 'alice', task: 'assistant.turn' }),
      complete: async (input) => {
        const names = (input.tools ?? []).map((t) => (t as { function: { name: string } }).function.name)
        const sys = input.messages.find((m) => m.role === 'system')?.content ?? ''
        if (input.modelOverride === 'openai/gpt-5-mini') {
          gptTools = names
          gptSystem = sys
        } else {
          deepseekTools = names
          deepseekSystem = sys
        }
        return {
          choices: [{ message: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }
      },
    })

    const gptEvents = api.stream(gatewayModelDescriptor('openai/gpt-5-mini'), context, { sessionId: 's1' } as never)
    await gptEvents.result()

    expect(gptTools).toHaveLength(128)
    expect(gptTools[0]).toBe('ee')
    for (const name of priorityNames) {
      expect(gptTools).toContain(name.replace(/\./g, '__'))
    }
    for (const wireName of gptTools) {
      expect(wireName).toMatch(WIRE_NAME_RE)
    }
    expect(gptSystem).toContain('You are a co-worker.')
    expect(gptSystem).toMatch(/additional company tools.*`ee`/i)

    const deepseekEvents = api.stream(
      gatewayModelDescriptor('~deepseek/deepseek-flash-latest'),
      context,
      { sessionId: 's2' } as never,
    )
    await deepseekEvents.result()

    expect(deepseekTools).toHaveLength(160)
    expect(deepseekSystem).toBe('You are a co-worker.')
  })
})

describe('buildToolNameCodec and multi-turn wire encoding', () => {
  it('keeps ee unchanged and bijectively maps dotted, invalid, colliding, and overlong names within 64 chars', () => {
    const longName = `ns.${'x'.repeat(80)}`
    const invalidName = 'foo/bar:baz'
    const names = [
      'ee',
      'messages.post',
      'website.list_pages',
      'a.b.c',
      'a.b',
      'a__b',
      longName,
      invalidName,
    ]

    const codec = buildToolNameCodec(names)
    expect(codec.toWire('ee')).toBe('ee')
    expect(codec.toWire('messages.post')).toBe('messages__post')
    expect(codec.toWire('website.list_pages')).toBe('website__list_pages')
    expect(codec.toWire('a.b.c')).toBe('a__b__c')
    expect(codec.toWire('a__b')).toBe('a__b')
    expect(codec.toWire('a.b')).not.toBe('a__b')

    const wireNames = names.map((n) => codec.toWire(n))
    expect(new Set(wireNames).size).toBe(names.length)
    for (const wire of wireNames) {
      expect(wire).toMatch(WIRE_NAME_RE)
    }
    for (const original of names) {
      expect(codec.fromWire(codec.toWire(original))).toBe(original)
    }

    // Reverse insertion order still avoids collisions
    const reverseCodec = buildToolNameCodec(['a__b', 'a.b'])
    expect(reverseCodec.toWire('a__b')).toBe('a__b')
    expect(reverseCodec.toWire('a.b')).not.toBe('a__b')
    expect(reverseCodec.toWire('a.b')).toMatch(WIRE_NAME_RE)
    expect(reverseCodec.fromWire(reverseCodec.toWire('a.b'))).toBe('a.b')
    expect(reverseCodec.fromWire(reverseCodec.toWire('a__b'))).toBe('a__b')
  })

  it('encodes multi-turn tool_calls in toOpenAiMessages (including historical tool calls not in current tools) and decodes via codec', () => {
    const context = {
      messages: [
        {
          role: 'system',
          content: 'System prompt',
          toolsAdded: [makeTool('ee'), makeTool('messages.post')],
          timestamp: 0,
        },
        { role: 'user', content: 'go', timestamp: 1 },
        {
          role: 'assistant',
          content: [
            { type: 'toolCall', id: 'c1', name: 'messages.post', arguments: { body: 'hi' } },
            { type: 'toolCall', id: 'c2', name: 'legacy.old_tool', arguments: { id: 1 } },
          ],
          timestamp: 2,
        },
        {
          role: 'toolResult',
          toolCallId: 'c1',
          toolName: 'messages.post',
          content: [{ type: 'text', text: '{"ok":true}' }],
          isError: false,
          timestamp: 3,
        },
        {
          role: 'toolResult',
          toolCallId: 'c2',
          toolName: 'legacy.old_tool',
          content: [{ type: 'text', text: '{"done":true}' }],
          isError: false,
          timestamp: 4,
        },
      ],
    } as unknown as TranscriptContext

    const codec = buildToolNameCodec(['ee', 'messages.post', 'legacy.old_tool'])
    const withCodec = toOpenAiMessages(context, codec)
    const assistantWithCodec = withCodec.find((m) => m.role === 'assistant')
    expect(assistantWithCodec?.tool_calls?.map((c) => c.function.name)).toEqual([
      'messages__post',
      'legacy__old_tool',
    ])

    const implicitCodec = toOpenAiMessages(context)
    const assistantImplicit = implicitCodec.find((m) => m.role === 'assistant')
    expect(assistantImplicit?.tool_calls?.map((c) => c.function.name)).toEqual([
      'messages__post',
      'legacy__old_tool',
    ])

    const decoded = assistantMessageFromGatewayResponse(
      {
        choices: [
          {
            message: {
              content: '',
              tool_calls: [{ id: 'c3', function: { name: 'messages__post', arguments: '{"body":"hi"}' } }],
            },
            finish_reason: 'tool_calls',
          },
        ],
      },
      model,
      'sess',
      codec,
    )
    expect(decoded.content).toEqual([
      { type: 'toolCall', id: 'c3', name: 'messages.post', arguments: { body: 'hi' } },
    ])
  })
})

describe('assistantMessageFromGatewayResponse', () => {
  it('maps text + usage', () => {
    const m = assistantMessageFromGatewayResponse(
      { choices: [{ message: { content: 'hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } },
      model,
      'sess',
    )
    expect(m.stopReason).toBe('stop')
    expect(m.content).toEqual([{ type: 'text', text: 'hi' }])
    expect(m.usage).toMatchObject({ input: 3, output: 2 })
  })

  it('maps tool calls with parsed arguments', () => {
    const m = assistantMessageFromGatewayResponse(
      {
        choices: [
          {
            message: { content: '', tool_calls: [{ id: 'c1', function: { name: 'memory.search', arguments: '{"q":"x"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
      model,
      'sess',
    )
    expect(m.stopReason).toBe('toolUse')
    expect(m.content).toEqual([{ type: 'toolCall', id: 'c1', name: 'memory.search', arguments: { q: 'x' } }])
  })

  it('malformed tool arguments become argumentsError, never a silent guess', () => {
    const m = assistantMessageFromGatewayResponse(
      { choices: [{ message: { tool_calls: [{ id: 'c1', function: { name: 't', arguments: '{oops' } }] }, finish_reason: 'tool_calls' }] },
      model,
      'sess',
    )
    expect(m.content[0]).toMatchObject({ type: 'toolCall', arguments: {}, argumentsError: expect.stringMatching(/not valid JSON/) })
  })

  it('fails loud on a response without choices or with an unknown finish reason', () => {
    expect(() => assistantMessageFromGatewayResponse({}, model, 's')).toThrow(/no choices/)
    // An unknown finish reason becomes an error-state message (the stream reports it), never a guessed "stop".
    const m = assistantMessageFromGatewayResponse({ choices: [{ message: { content: 'x' }, finish_reason: 'weird' }] }, model, 's')
    expect(m.stopReason).toBe('error')
    expect(m.errorMessage).toMatch(/unsupported finish_reason/)
  })
})
