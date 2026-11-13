import { describe, expect, it } from 'vitest'
import { DEFAULT_MOCK_TOOL, MOCK_ANSWER, mockChatCompletion } from './mock-gateway-chat.mjs'

const tool = (name: string) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
})

describe('mockChatCompletion', () => {
  it('answers a connection-test ping (max_tokens 1) with plain text and no delay', () => {
    const out = mockChatCompletion({ model: 'm', max_tokens: 1, messages: [] }, {})
    expect(out.delayMs).toBe(0)
    expect(out.response.choices[0].message).toEqual({ role: 'assistant', content: 'pong' })
  })

  it('emits a native tool call first when the default tool is offered', () => {
    const out = mockChatCompletion(
      {
        model: 'mock-chat-model',
        tools: [tool('remember'), tool(DEFAULT_MOCK_TOOL)],
        messages: [{ role: 'user', content: 'hi' }],
      },
      {},
    )
    const choice = out.response.choices[0]
    expect(choice.finish_reason).toBe('tool_calls')
    expect(choice.message.content).toBeNull()
    expect(choice.message.tool_calls).toHaveLength(1)
    expect(choice.message.tool_calls[0]).toMatchObject({
      type: 'function',
      function: { name: DEFAULT_MOCK_TOOL, arguments: '{}' },
    })
    expect(typeof choice.message.tool_calls[0].id).toBe('string')
    // Never the retired builtin-json tool-intent text.
    expect(JSON.stringify(out.response)).not.toContain('"tool":')
  })

  it('answers in plain text once the tool result came back', () => {
    const out = mockChatCompletion(
      {
        model: 'mock-chat-model',
        tools: [tool(DEFAULT_MOCK_TOOL)],
        messages: [
          { role: 'user', content: 'hi' },
          {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'c1',
                type: 'function',
                function: { name: DEFAULT_MOCK_TOOL, arguments: '{}' },
              },
            ],
          },
          { role: 'tool', tool_call_id: 'c1', content: '{"projects":[]}' },
        ],
      },
      {},
    )
    const choice = out.response.choices[0]
    expect(choice.finish_reason).toBe('stop')
    expect(choice.message).toEqual({ role: 'assistant', content: MOCK_ANSWER })
  })

  it('answers in plain text when no tool is offered', () => {
    const out = mockChatCompletion({ messages: [{ role: 'user', content: 'hi' }] }, {})
    expect(out.response.choices[0].message.content).toBe(MOCK_ANSWER)
    expect(out.response.choices[0].finish_reason).toBe('stop')
  })

  it('answers in plain text when the offered tools do not include the chosen one', () => {
    const out = mockChatCompletion(
      { tools: [tool('remember')], messages: [{ role: 'user', content: 'hi' }] },
      {},
    )
    expect(out.response.choices[0].message.content).toBe(MOCK_ANSWER)
  })

  it('[mock-tool:name] in the latest user message picks the tool', () => {
    const out = mockChatCompletion(
      {
        tools: [tool('remember'), tool(DEFAULT_MOCK_TOOL)],
        messages: [{ role: 'user', content: 'do it [mock-tool:remember]' }],
      },
      {},
    )
    expect(out.response.choices[0].message.tool_calls[0].function.name).toBe('remember')
  })

  it('[mock-tool:none] skips the tool call', () => {
    const out = mockChatCompletion(
      {
        tools: [tool(DEFAULT_MOCK_TOOL)],
        messages: [{ role: 'user', content: 'plain [mock-tool:none]' }],
      },
      {},
    )
    expect(out.response.choices[0].message.content).toBe(MOCK_ANSWER)
  })

  it('[mock-json:b64url] answers with exactly the decoded text, even when tools are offered', () => {
    const verdict = JSON.stringify({ kind: 'bug', area: 'messages', duplicate_of: null })
    const marker = `[mock-json:${Buffer.from(verdict).toString('base64url')}]`
    const { response } = mockChatCompletion(
      { messages: [{ role: 'user', content: `Draft:\n"Threads ${marker}"` }], tools: [{ function: { name: DEFAULT_MOCK_TOOL } }] },
      {},
    )
    expect(response.choices[0]).toMatchObject({ message: { role: 'assistant', content: verdict }, finish_reason: 'stop' })
  })

  it('[mock-json@Tag:b64url] answers only the call whose user message opens with "Tag:"; others get the plain [mock-json:…]', () => {
    const b64 = (s: string) => Buffer.from(s).toString('base64url')
    const verdict = JSON.stringify({ kind: 'bug', area: 'messages', duplicate_of: null })
    const scrub = JSON.stringify({ summary: 'Keep thread replies', language: 'en', removed: ['person', 'url'] })
    const title = `Threads [mock-json:${b64(verdict)}] [mock-json@Proposal:${b64(scrub)}]`
    const judge = mockChatCompletion({ messages: [{ role: 'user', content: `Draft:\n${JSON.stringify(title)}` }] }, {})
    expect(judge.response.choices[0].message.content).toBe(verdict)
    const scrubbed = mockChatCompletion({ messages: [{ role: 'user', content: `Proposal:\n${JSON.stringify(title)}` }] }, {})
    expect(scrubbed.response.choices[0].message.content).toBe(scrub)
    // A tagged marker alone never answers another call's tag.
    const other = mockChatCompletion({ messages: [{ role: 'user', content: `Draft:\n"x [mock-json@Proposal:${b64(scrub)}]"` }] }, {})
    expect(other.response.choices[0].message.content).toBe(MOCK_ANSWER)
  })

  it('[mock-delay:ms] in the latest user message delays every completion of the turn', () => {
    const base = {
      tools: [tool(DEFAULT_MOCK_TOOL)],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'slow [mock-delay:8000]' }] }],
    }
    expect(mockChatCompletion(base, {}).delayMs).toBe(8000)
    const after = {
      ...base,
      messages: [
        ...base.messages,
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'c1', type: 'function', function: { name: DEFAULT_MOCK_TOOL, arguments: '{}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'c1', content: 'not_run' },
      ],
    }
    expect(mockChatCompletion(after, {}).delayMs).toBe(8000)
  })

  it('MOCK_GATEWAY_DELAY_MS sets a default delay; the prompt marker wins', () => {
    const msgs = [{ role: 'user', content: 'hi' }]
    expect(mockChatCompletion({ messages: msgs }, { MOCK_GATEWAY_DELAY_MS: '250' }).delayMs).toBe(
      250,
    )
    expect(
      mockChatCompletion(
        { messages: [{ role: 'user', content: 'x [mock-delay:5]' }] },
        { MOCK_GATEWAY_DELAY_MS: '250' },
      ).delayMs,
    ).toBe(5)
  })

  it('fails loud on a malformed delay env', () => {
    expect(() => mockChatCompletion({ messages: [] }, { MOCK_GATEWAY_DELAY_MS: 'soon' })).toThrow(
      /MOCK_GATEWAY_DELAY_MS/,
    )
  })
})
