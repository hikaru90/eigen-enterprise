import type { ResolvedLlmConfig } from './types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getDbMock } = vi.hoisted(() => ({ getDbMock: vi.fn() }))
vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/activity/log-call', () => ({ logActivityCall: vi.fn() }))

import { fetchProviderChatCompletion, usesApiShape } from './api-shapes'

function response(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const anthropicConfig: ResolvedLlmConfig = {
  provider: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  apiKey: 'sk-ant-oat-test',
  ruleChat: null,
  ruleEmbedding: null,
  modelChat: 'claude-sonnet-4-5',
  modelEmbedding: null,
}

const codexConfig: ResolvedLlmConfig = {
  provider: 'openai_codex',
  baseUrl: 'https://chatgpt.com/backend-api',
  apiKey: ['e30', btoa(JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-9' } })).replace(/=/g, ''), 'sig'].join('.'),
  ruleChat: null,
  ruleEmbedding: null,
  modelChat: 'gpt-5.1-codex',
  modelEmbedding: null,
}

const MESSAGES = [
  { role: 'system' as const, content: 'You are a helpful assistant.' },
  { role: 'user' as const, content: 'hello' },
]

describe('api-shape adapters', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('routes anthropic + openai_codex through adapters, others not', () => {
    expect(usesApiShape('anthropic')).toBe(true)
    expect(usesApiShape('openai_codex')).toBe(true)
    expect(usesApiShape('eurouter')).toBe(false)
    expect(usesApiShape('openrouter')).toBe(false)
    expect(usesApiShape('github_copilot')).toBe(false)
  })

  it('sends the Anthropic messages shape with OAuth identity and normalizes the reply', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          model: 'claude-sonnet-4-5',
          content: [{ type: 'text', text: 'pong from claude' }],
          usage: { input_tokens: 3, output_tokens: 2 },
        }),
      json: async () => ({
        model: 'claude-sonnet-4-5',
        content: [{ type: 'text', text: 'pong from claude' }],
        usage: { input_tokens: 3, output_tokens: 2 },
      }),
    }) as unknown as Response)
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchProviderChatCompletion(anthropicConfig, {
      model: 'claude-sonnet-4-5',
      messages: MESSAGES,
      maxTokens: 32,
    })
    const body = JSON.parse(await res.text()) as {
      model: string
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }

    expect(body.model).toBe('claude-sonnet-4-5')
    expect(body.choices[0]?.message.content).toBe('pong from claude')
    expect(body.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 })

    const requestUrl = String(fetchMock.mock.calls[0]![0])
    expect(requestUrl).toBe('https://api.anthropic.com/v1/messages')
    const init = fetchMock.mock.calls[0]![1]!
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer sk-ant-oat-test')
    expect(headers['anthropic-beta']).toContain('oauth-2025-04-20')
    expect(headers['anthropic-beta']).toContain('claude-code-20250219')
    const sentBody = JSON.parse(init.body as string) as {
      system: Array<{ text: string }>
      max_tokens: number
      stream: boolean
      messages: Array<{ role: string }>
    }
    expect(sentBody.system[0].text).toContain('Claude Code')
    expect(sentBody.messages).toEqual([
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ].filter((m) => m.role !== 'system') as Array<{ role: string }>)
    expect(sentBody.max_tokens).toBe(32)
    expect(sentBody.stream).toBe(false)
  })

  it('passes Anthropic HTTP failures through with their status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(false, 401, { error: 'bad token' })))

    const res = await fetchProviderChatCompletion(anthropicConfig, {
      model: 'claude-sonnet-4-5',
      messages: MESSAGES,
      maxTokens: 32,
    })
    expect(res.status).toBe(401)
  })

  it('accumulates the Codex SSE stream into a normalized response', async () => {
    const events = [
      { type: 'response.created' },
      { type: 'response.output_text.delta', delta: 'pong ' },
      { type: 'response.output_text.delta', delta: 'from codex' },
      {
        type: 'response.completed',
        response: {
          model: 'gpt-5.1-codex',
          output: [
            {
              type: 'message',
              content: [{ type: 'output_text', text: 'pong from codex' }],
            },
          ],
          usage: { input_tokens: 5, output_tokens: 7 },
        },
      },
    ]
    const sse = events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join('')
    const fetchMock = vi.fn(async () => {
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(sse))
          controller.close()
        },
      })
      return { ok: true, status: 200, body: stream } as unknown as Response
    })
    vi.stubGlobal('fetch', fetchMock)

    const res = await fetchProviderChatCompletion(codexConfig, {
      model: 'gpt-5.1-codex',
      messages: MESSAGES,
      maxTokens: 128,
    })
    const body = JSON.parse(await res.text()) as {
      model: string
      choices: Array<{ message: { content: string } }>
      usage: { prompt_tokens: number; completion_tokens: number }
    }
    expect(body.choices[0]?.message.content).toBe('pong from codex')
    expect(body.model).toBe('gpt-5.1-codex')
    expect(body.usage).toEqual({ prompt_tokens: 5, completion_tokens: 7, total_tokens: 12 })

    const headers = fetchMock.mock.calls[0]![1]!.headers as Record<string, string>
    expect(headers.Authorization).toBe(`Bearer ${codexConfig.apiKey}`)
    expect(headers['chatgpt-account-id']).toBe('acct-9')
    expect(headers['OpenAI-Beta']).toBe('responses=experimental')
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://chatgpt.com/backend-api/codex/responses',
    )
    const sentBody = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      stream: boolean
      store: boolean
      instructions: string
      input: Array<{ role: string }>
    }
    expect(sentBody.stream).toBe(true)
    expect(sentBody.store).toBe(false)
    expect(sentBody.instructions).toBe('You are a helpful assistant.')
    expect(sentBody.input).toEqual([
      { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
    ])
  })

  it('returns the raw failure status when the Codex stream errors before completing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 401, { error: { message: 'expired token' } })),
    )
    const res = await fetchProviderChatCompletion(codexConfig, {
      model: 'gpt-5.1-codex',
      messages: MESSAGES,
      maxTokens: 128,
    })
    expect(res.status).toBe(401)
  })
})
