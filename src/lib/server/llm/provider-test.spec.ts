import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResolvedLlmConfig } from './types'

const { logActivityCallMock, getDbMock } = vi.hoisted(() => ({
  logActivityCallMock: vi.fn(),
  getDbMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/activity/log-call', () => ({ logActivityCall: logActivityCallMock }))

import { testLlmProviderConnection } from './provider-test'

function response(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

const openrouterConfig: ResolvedLlmConfig = {
  provider: 'openrouter',
  baseUrl: 'https://openrouter.example/api/v1',
  apiKey: 'key-1',
  ruleChat: null,
  ruleEmbedding: null,
  modelChat: 'openai/gpt-4o-mini',
  modelEmbedding: null,
}

const eurouterConfig: ResolvedLlmConfig = {
  provider: 'eurouter',
  baseUrl: 'https://gw.example.test/v1',
  apiKey: 'key-2',
  ruleChat: 'rule-chat-1',
  ruleEmbedding: 'rule-embed-1',
  modelChat: null,
  modelEmbedding: null,
}

describe('testLlmProviderConnection', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getDbMock.mockReturnValue({})
  })

  it('pings with a 1-token completion and reports ok with model + latency', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, {
        model: 'openai/gpt-4o-mini',
        choices: [{ message: { role: 'assistant', content: 'ok' } }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = await testLlmProviderConnection('u1', openrouterConfig)

    expect(result).toMatchObject({ ok: true, model: 'openai/gpt-4o-mini' })
    expect((result as { latencyMs: number }).latencyMs).toBeGreaterThanOrEqual(0)

    const body = JSON.parse(fetchMock.mock.calls[0]![1]!.body as string) as {
      model: string
      max_tokens: number
      messages: Array<{ role: string; content: string }>
    }
    expect(body.model).toBe('openai/gpt-4o-mini')
    expect(body.max_tokens).toBe(1)
    expect(body.messages).toEqual([{ role: 'user', content: 'ping' }])
    expect(String(fetchMock.mock.calls[0]![0])).toBe(
      'https://openrouter.example/api/v1/chat/completions',
    )
  })

  it('resolves the EUrouter routing rule before pinging', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true, 200, { data: { model: 'rule-model-7' } }))
      .mockResolvedValueOnce(response(true, 200, { choices: [] }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await testLlmProviderConnection('u1', eurouterConfig)

    expect(result).toMatchObject({ ok: true, model: 'rule-model-7' })
    expect(String(fetchMock.mock.calls[0]![0])).toContain('/routing-rules/rule-chat-1')
    const body = JSON.parse(fetchMock.mock.calls[1]![1]!.body as string) as { rule_id?: string }
    expect(body.rule_id).toBe('rule-chat-1')
  })

  it('fails loud with the gateway error on HTTP failure', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(false, 401, { error: 'bad key' })))

    const result = await testLlmProviderConnection('u1', openrouterConfig)

    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('401')
    expect((result as { error: string }).error).toContain('bad key')
  })

  it('fails when a routing rule lookup fails', async () => {
    // Unique rule id: llm-client's routingRuleCache persists across tests in this file.
    const failing = { ...eurouterConfig, ruleChat: 'rule-chat-404' }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 404, { error: 'no such rule' })),
    )

    const result = await testLlmProviderConnection('u1', failing)

    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toContain('rule-chat-404')
  })

  it('fails without any request when a chat rule/model is missing entirely', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await testLlmProviderConnection('u1', {
      ...openrouterConfig,
      modelChat: null,
    })

    expect(result).toMatchObject({ ok: false })
    expect((result as { error: string }).error).toMatch(/model/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('logs the provider-test call for cost tracking', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response(true, 200, { choices: [] })))

    await testLlmProviderConnection('u1', openrouterConfig)

    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        provider: 'openrouter',
        operation: expect.stringContaining('llm.chat.provider-test'),
      }),
    )
  })
})
