import { describe, expect, it } from 'vitest'
import { assistantMessageFromGatewayResponse, gatewayModelDescriptor } from './gateway-model'

const model = gatewayModelDescriptor()

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
