import { describe, expect, it } from 'vitest'
import { parseChatNdjson, tapToolCalls } from './chat'

describe('the /api/chat NDJSON stream, as the eval reads it', () => {
  it('collects the reply, approvals and the terminal frame', () => {
    const text = [
      JSON.stringify({ type: 'message_delta', content: 'Hel' }),
      JSON.stringify({ type: 'tool.preview', tool: 'drive.list', inputSummary: null }),
      JSON.stringify({ type: 'approval.required', tool: 'email.send_mail', approvalId: 'a1' }),
      JSON.stringify({ type: 'done', response: 'Hello', sessionId: 's1', messageId: 'm1' }),
      '',
    ].join('\n')
    expect(parseChatNdjson(text)).toEqual({ reply: 'Hello', sessionId: 's1', error: null, approvals: ['email.send_mail'], previews: ['drive.list'] })
  })

  it('an error frame is the turn’s error; a stream without a terminal frame is one too', () => {
    expect(parseChatNdjson(JSON.stringify({ type: 'error', error: 'LLM not configured' })).error).toBe('LLM not configured')
    expect(parseChatNdjson(JSON.stringify({ type: 'message_delta', content: 'x' })).error).toBe('the stream ended without a done or error frame')
  })

  it('a malformed line fails loud', () => {
    expect(() => parseChatNdjson('{nope')).toThrow(/not JSON/)
  })
})

describe('tapping the registry: every tool call of a turn, with its output', () => {
  it('records calls per acting user and still returns / throws exactly what the registry did', async () => {
    const registry = {
      execute: async (tool: string, input: unknown, _ctx: { actingUserId?: string }) => {
        if (tool === 'bad') throw new Error('nope')
        return { echo: input }
      },
    }
    const tap = tapToolCalls(registry)
    await expect(registry.execute('a', { x: 1 }, { actingUserId: 'u1' })).resolves.toEqual({ echo: { x: 1 } })
    await expect(registry.execute('bad', {}, { actingUserId: 'u1' })).rejects.toThrow('nope')
    await registry.execute('a', {}, { actingUserId: 'u2' })
    expect(tap.take('u1')).toEqual([
      { tool: 'a', input: { x: 1 }, ok: true, output: '{"echo":{"x":1}}' },
      { tool: 'bad', input: {}, ok: false, output: 'Error: nope' },
    ])
    expect(tap.take('u1')).toEqual([])
    expect(tap.take('u2')).toHaveLength(1)
  })
})
