import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ExtendedPrivateEnv } from '$lib/server/env/private-env'
import { fetchMockInit, fetchMockUrl } from '$lib/test/vitest-mock-call'
import { LlmDailyCapError, LlmNotConfiguredError } from './errors'
import { ModelNotInPoolError } from './model-pool'
import {
  DEFAULT_CHAT_MAX_TOKENS,
  describeChatModel,
  llmChatCompletion,
  llmCreateEmbeddings,
  llmCreateSpeech,
  llmCreateTranscription,
} from './llm-client'

/** The company's per-person daily AI cap (DC3): unset (null) unless a spec sets it. */
const { capStore } = vi.hoisted(() => ({
  capStore: {
    cap: null as number | null,
    roles: {} as Record<string, 'owner' | 'admin' | 'member'>,
    spent: {} as Record<string, number>,
  },
}))
vi.mock('$lib/server/llm/member-daily-cap-store', () => ({
  memberDailyCapStore: {
    readCapUsd: async () => capStore.cap,
    roleOf: async (userId: string) => capStore.roles[userId] ?? null,
    kindOf: async (userId: string) => (capStore.roles[userId] ? 'human' : null),
    spentUsdSince: async (userId: string) => capStore.spent[userId] ?? 0,
    setCapUsd: async () => {},
  },
}))

const { mockEnv, logActivityCallMock, getDbMock, decryptTenantValueMock, captureServerEventMock } =
  vi.hoisted(() => {
    function makeDbMock() {
      // Returns a chainable Drizzle-style builder that resolves to [] (no DB rows).
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.from = () => chain
      chain.where = () => chain
      chain.and = () => chain
      chain.limit = () => Promise.resolve([])
      return chain
    }

    return {
      mockEnv: {
        LLM_BASE_URL: 'https://example.test',
        LLM_RULE_CHAT: 'rule-chat',
        LLM_RULE_EMBEDDING: 'rule-embed',
        LLM_MODEL_CHAT: 'gpt-test',
        LLM_MODEL_EMBEDDING: 'text-embedding-3-small',
        LLM_MIN_REQUEST_INTERVAL_MS: '0',
        LLM_REQUEST_TIMEOUT_MS: '',
        LLM_SERIAL_REQUESTS: '',
        LLM_API_KEY: 'key-1',
        SERVICE_API_KEY_EUROUTER: 'service-eurouter-key',
        OPENROUTER_BASE_URL: 'https://openrouter.example/api/v1',
        OPENROUTER_API_KEY: 'openrouter-key',
        SERVICE_API_KEY_OPENROUTER: 'service-openrouter-key',
      } as ExtendedPrivateEnv,
      logActivityCallMock: vi.fn(),
      getDbMock: vi.fn(() => makeDbMock()),
      decryptTenantValueMock: vi.fn(async () => 'decrypted-key'),
      captureServerEventMock: vi.fn(),
    }
  })

vi.mock('$lib/server/env/private-env', () => ({
  env: mockEnv,
}))

vi.mock('$lib/server/db', () => ({
  getDb: getDbMock,
  withDbUser: async (_userId: string, fn: (db: ReturnType<typeof getDbMock>) => Promise<unknown>) =>
    fn(getDbMock()),
}))

vi.mock('$lib/server/activity/log-call', () => ({
  logActivityCall: logActivityCallMock,
}))

vi.mock('$lib/server/analytics/posthog-server', () => ({
  captureServerEvent: captureServerEventMock,
}))

vi.mock('$lib/server/llm/preferences', () => ({
  isByokBilling: vi.fn(async () => true),
}))

/**
 * Since CB1 the gateway resolves the COMPANY's source (the Settings → AI switch), not the
 * caller's billing mode. These specs keep steering it through the `isByokBilling` mock: the
 * switch is off (own key) exactly when it answers true. The company's key is on account 'u1'.
 */
const { companyPicks, pinnedEmbedding } = vi.hoisted(() => ({
  companyPicks: { chat: null as string | null, stt: null as string | null, tts: null as string | null, decision: null as string | null },
  pinnedEmbedding: { model: null as string | null },
}))
vi.mock('$lib/server/llm/company-ai', () => ({
  companyAiStore: () => ({
    read: async () => {
      const { isByokBilling } = await import('$lib/server/llm/preferences')
      return {
        useEigenInference: !(await isByokBilling('u1')),
        picks: { ...companyPicks },
        embeddingModel: pinnedEmbedding.model,
      }
    },
    pinEmbeddingModel: async (model: string) => model,
  }),
}))
vi.mock('$lib/server/llm/company-provider', () => ({
  companyOwnerId: async () => 'u1',
}))

vi.mock('$lib/server/crypto/tenant-encryption', () => ({
  decryptTenantValue: decryptTenantValueMock,
}))

function mockSequentialDbLimitResults(...results: unknown[][]) {
  let index = 0
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.from = () => chain
  chain.where = () => chain
  chain.limit = () => {
    const rows = results[index] ?? []
    index += 1
    return Promise.resolve(rows)
  }
  getDbMock.mockReturnValue(chain)
  return chain
}

function fetchThatWaitsForAbort(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise((_resolve, reject) => {
      const signal = init?.signal
      if (signal?.aborted) {
        reject(signal.reason)
        return
      }
      signal?.addEventListener('abort', () => reject(signal.reason))
    })
  })
}

function response(ok: boolean, status: number, body: unknown): Response {
  return {
    ok,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response
}

describe('llm client retries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_RULE_EMBEDDING = 'rule-embed'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_MODEL_EMBEDDING = 'text-embedding-3-small'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_API_KEY = 'key-1'
  })

  it('chat succeeds and logs cost as 0 when response has no usage field', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { choices: [] })),
    )

    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        operation: 'llm.chat.chat.success(attempt=1)',
        baseCostUsd: 0,
        gatewayHost: 'example.test',
      }),
    )
  })

  it('chat succeeds and logs activity', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          usage: { prompt_tokens: 10, completion_tokens: 10 },
          choices: [],
        }),
      ),
    )

    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
    })

    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        provider: 'eurouter',
        operation: 'llm.chat.chat.success(attempt=1)',
        gatewayHost: 'example.test',
      }),
    )
  })

  it('captures ai generation on successful chat completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 },
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'ok' } }],
        }),
      ),
    )

    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello observability' }],
      aiSessionId: 'session-1',
      aiTraceId: 'trace-1',
    })

    expect(captureServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'u1',
        event: '$ai_generation',
        properties: expect.objectContaining({
          $ai_session_id: 'session-1',
          $ai_trace_id: 'trace-1',
          $ai_model: 'gpt-test',
          $ai_provider: 'eurouter',
          $ai_input_tokens: 12,
          $ai_output_tokens: 34,
          $ai_stop_reason: 'stop',
          $ai_latency: expect.any(Number),
        }),
      }),
    )
  })

  it('chat includes temperature when provided', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
      temperature: 0.7,
    })

    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      temperature?: number
      model?: string
    }
    expect(body.temperature).toBe(0.7)
    expect(body.model).toBe('gpt-test')
  })

  it('chat retries exactly three attempts then fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 500, { error: 'down' })),
    )
    await expect(
      llmChatCompletion({
        userId: 'u1',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow(/LLM HTTP 500/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  // demo box 2026-11-25: a compaction summary came back finish_reason "length" at
  // 1639 of 8192 tokens (prompt 2410 + 1639 ≈ a 4k-context upstream provider).
  // The answer was cut short by the provider, not by our budget.
  it('retries a reply the provider cut short below our max_tokens', async () => {
    const cut = {
      usage: { prompt_tokens: 2410, completion_tokens: 1639, total_tokens: 4049 },
      choices: [{ finish_reason: 'length', message: { content: 'half a summ' } }],
    }
    const whole = {
      usage: { prompt_tokens: 2410, completion_tokens: 2100, total_tokens: 4510 },
      choices: [{ finish_reason: 'stop', message: { content: 'the whole summary' } }],
    }
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true, 200, cut))
      .mockResolvedValueOnce(response(true, 200, whole))
    vi.stubGlobal('fetch', fetchMock)

    const out = await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'summarize' }],
      maxTokens: 8192,
    })

    expect(out).toEqual(whole)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // The cut-short call was billed: its activity row keeps the call, under its own name.
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ operation: 'llm.chat.chat.cut_short(attempt=1)' }),
    )
    expect(logActivityCallMock).not.toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ operation: expect.stringMatching(/\.error\(attempt=1\)/) }),
    )
  })

  it('fails loud when every attempt is cut short by the provider', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          usage: { prompt_tokens: 2410, completion_tokens: 1639 },
          choices: [{ finish_reason: 'length', message: { content: 'half' } }],
        }),
      ),
    )
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'x' }], maxTokens: 8192 }),
    ).rejects.toThrow(/cut the reply short at 1639 of 8192 tokens/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('returns a reply that used our whole max_tokens budget as is (finish_reason length)', async () => {
    const full = {
      usage: { prompt_tokens: 10, completion_tokens: DEFAULT_CHAT_MAX_TOKENS },
      choices: [{ finish_reason: 'length', message: { content: 'long' } }],
    }
    vi.stubGlobal('fetch', vi.fn(async () => response(true, 200, full)))
    const out = await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'x' }] })
    expect(out).toEqual(full)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('captures ai generation error when all chat retries fail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 500, { error: 'down' })),
    )

    await expect(
      llmChatCompletion({
        userId: 'u1',
        messages: [{ role: 'user', content: 'hello' }],
        aiSessionId: 'session-error',
        aiTraceId: 'trace-error',
      }),
    ).rejects.toThrow(/LLM HTTP 500/)

    expect(captureServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: 'u1',
        event: '$ai_generation',
        properties: expect.objectContaining({
          $ai_session_id: 'session-error',
          $ai_trace_id: 'trace-error',
          $ai_model: 'gpt-test',
          $ai_provider: 'eurouter',
          $ai_http_status: 500,
          $ai_is_error: true,
          $ai_error: expect.any(String),
        }),
      }),
    )
  })

  it('fails when chat api key is missing', async () => {
    mockEnv.LLM_API_KEY = ''
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toBeInstanceOf(LlmNotConfiguredError)
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/LLM_API_KEY/)
  })

  it('parses gateway host from bare hostnames and invalid URLs', async () => {
    mockEnv.LLM_BASE_URL = 'api.example.test/'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { choices: [{ message: { content: 'ok' } }] })),
    )
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ gatewayHost: 'api.example.test' }),
    )
  })

  it('rejects invalid LLM_REQUEST_TIMEOUT_MS', async () => {
    mockEnv.LLM_REQUEST_TIMEOUT_MS = '0'
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/LLM_REQUEST_TIMEOUT_MS/)
  })

  it('rejects invalid LLM_MIN_REQUEST_INTERVAL_MS', async () => {
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = 'not-a-number'
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/LLM_MIN_REQUEST_INTERVAL_MS/)
  })

  it('falls back to trimmed base URL when gateway host cannot be parsed', async () => {
    mockEnv.LLM_BASE_URL = '%%%not-a-valid-url%%%'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { choices: [] })),
    )
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ gatewayHost: '%%%not-a-valid-url%%%' }),
    )
  })

  it('asks for 1536 dims and shortens a Matryoshka model that ignored it (Qwen3: 4096)', async () => {
    mockEnv.LLM_MODEL_EMBEDDING = 'qwen/qwen3-embedding-8b'
    const fetchMock = vi.fn(async () =>
      response(true, 200, { data: [{ embedding: Array.from({ length: 4096 }, () => 0.5) }] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const out = (await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })) as {
      data: { embedding: number[] }[]
    }
    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(sent).toMatchObject({ model: 'qwen/qwen3-embedding-8b', dimensions: 1536 })
    expect(out.data[0]!.embedding).toHaveLength(1536)
    expect(Math.hypot(...out.data[0]!.embedding)).toBeCloseTo(1, 10)
  })

  it('embedding succeeds after retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(false, 500, { error: 'temp' }))
      .mockResolvedValueOnce(response(true, 200, { usage: { total_tokens: 100 }, data: [] }))
    vi.stubGlobal('fetch', fetchMock)

    await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        operation: 'llm.embedding.error(attempt=1)',
        gatewayHost: 'example.test',
      }),
    )
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        operation: 'llm.embedding.success(attempt=2)',
        gatewayHost: 'example.test',
      }),
    )
  })

  it('fails when required env is missing', async () => {
    mockEnv.LLM_API_KEY = ''
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /LLM_API_KEY/,
    )
  })

  it('fails when chat model and rule are both missing', async () => {
    mockEnv.LLM_MODEL_CHAT = ''
    mockEnv.LLM_RULE_CHAT = ''
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/LLM_RULE_CHAT/)
  })

  it('fails when embedding model and rule are both missing', async () => {
    mockEnv.LLM_MODEL_EMBEDDING = ''
    mockEnv.LLM_RULE_EMBEDDING = ''
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /LLM_RULE_EMBEDDING/,
    )
  })

  it('uses explicit chat model when provided', async () => {
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    const fetchMock = vi.fn(async () =>
      response(true, 200, {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      model: string
      rule_id?: string
    }
    expect(body.model).toBe('gpt-test')
    expect(body.rule_id).toBe('rule-chat')
  })

  it('resolves embedding model from routing rule when model env missing', async () => {
    mockEnv.LLM_MODEL_EMBEDDING = ''
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(true, 200, {
          data: { model: 'text-embedding-3-small', provider: { data_residency: 'EU' } },
        }),
      )
      .mockResolvedValueOnce(response(true, 200, { usage: { total_tokens: 5 }, data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })
    const body = JSON.parse(fetchMockInit(fetchMock, 1).body as string) as {
      model: string
      provider?: Record<string, unknown>
    }
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.provider).toEqual({ data_residency: 'EU' })
  })

  it('fails when base url is missing', async () => {
    mockEnv.LLM_BASE_URL = ''
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toBeInstanceOf(
      LlmNotConfiguredError,
    )
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /LLM_BASE_URL/,
    )
  })

  it('handles non-json error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 404,
            text: async () => 'route missing',
          }) as unknown as Response,
      ),
    )
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /LLM HTTP 404/,
    )
  })

  it('handles non-json chat error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 500,
            text: async () => 'oops',
          }) as unknown as Response,
      ),
    )
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/LLM HTTP 500/)
  })

  it('throws fallback error when fetch throws non-error value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject('boom')),
    )
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toThrow(/failed after 3 attempts/)
  })

  it('embedding throws fallback error on non-error throw', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject('boom')),
    )
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /failed after 3 attempts/,
    )
  })

  it('rejects negative or non-numeric LLM_MIN_REQUEST_INTERVAL_MS', async () => {
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '-1'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { usage: { total_tokens: 5 }, data: [] })),
    )
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /LLM_MIN_REQUEST_INTERVAL_MS must be a non-negative number/,
    )
  })

  it('rate-limits successive calls when interval is configured', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '50'
      vi.stubGlobal(
        'fetch',
        vi.fn(async () =>
          response(true, 200, {
            usage: { prompt_tokens: 1, completion_tokens: 1 },
            choices: [],
          }),
        ),
      )
      const { llmChatCompletion: chat } = await import('./llm-client')
      const first = chat({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
      await vi.advanceTimersByTimeAsync(0)
      const second = chat({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
      await vi.advanceTimersByTimeAsync(50)
      await first
      await second
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('pipelines in-flight requests when overlapping callers do not await prior completions', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '1000'
      const pendingResolvers: Array<(value: Response) => void> = []
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pendingResolvers.push(resolve)
          }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const { llmChatCompletion: chat } = await import('./llm-client')
      const okBody = {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [{ message: { content: 'ok' } }],
      }

      const first = chat({ userId: 'u1', messages: [{ role: 'user', content: '1' }] })
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const second = chat({ userId: 'u1', messages: [{ role: 'user', content: '2' }] })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(2)
      expect(pendingResolvers).toHaveLength(2)

      const third = chat({ userId: 'u1', messages: [{ role: 'user', content: '3' }] })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(3)
      expect(pendingResolvers).toHaveLength(3)

      for (const resolve of pendingResolvers) {
        resolve(response(true, 200, okBody))
      }
      await Promise.all([first, second, third])
    } finally {
      vi.useRealTimers()
    }
  })

  it('serial mode waits for prior request completion plus interval before the next starts', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '1000'
      mockEnv.LLM_SERIAL_REQUESTS = '1'
      const pendingResolvers: Array<(value: Response) => void> = []
      const fetchMock = vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            pendingResolvers.push(resolve)
          }),
      )
      vi.stubGlobal('fetch', fetchMock)

      const { llmChatCompletion: chat } = await import('./llm-client')
      const okBody = {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [{ message: { content: 'ok' } }],
      }

      const first = chat({ userId: 'u1', messages: [{ role: 'user', content: '1' }] })
      await vi.advanceTimersByTimeAsync(0)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      const second = chat({ userId: 'u1', messages: [{ role: 'user', content: '2' }] })
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(1)

      pendingResolvers[0]!(response(true, 200, okBody))
      await first
      await vi.advanceTimersByTimeAsync(1000)
      expect(fetchMock).toHaveBeenCalledTimes(2)

      pendingResolvers[1]!(response(true, 200, okBody))
      await second
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves chat routing rule via /routing-rules when model env is empty', async () => {
    vi.resetModules()
    mockEnv.LLM_MODEL_CHAT = ''
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true, 200, { data: { model: 'rule-model' } }))
      .mockResolvedValueOnce(
        response(true, 200, {
          usage: { prompt_tokens: 1, completion_tokens: 1 },
          choices: [],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    const { llmChatCompletion: chat } = await import('./llm-client')
    await chat({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    const body = JSON.parse(fetchMockInit(fetchMock, 1).body as string) as {
      model: string
      rule_id?: string
    }
    expect(body.model).toBe('rule-model')
    expect(body.rule_id).toBe('rule-chat')
  })

  it('throws when routing rule lookup fails', async () => {
    vi.resetModules()
    mockEnv.LLM_MODEL_EMBEDDING = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 404, { error: 'no such rule' })),
    )
    const { llmCreateEmbeddings: embed } = await import('./llm-client')
    await expect(embed({ userId: 'u1', input: 'hi' })).rejects.toThrow(/Routing rule lookup failed/)
  })

  it('omits rule_id from chat body when only LLM_MODEL_CHAT is set', async () => {
    mockEnv.LLM_RULE_CHAT = ''
    const fetchMock = vi.fn(async () =>
      response(true, 200, {
        usage: { prompt_tokens: 1, completion_tokens: 1 },
        choices: [],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      model: string
      rule_id?: string
    }
    expect(body.model).toBe('gpt-test')
    expect(body.rule_id).toBeUndefined()
  })

  it('omits rule_id from embedding body when only LLM_MODEL_EMBEDDING is set', async () => {
    mockEnv.LLM_RULE_EMBEDDING = ''
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { total_tokens: 1 }, data: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      model: string
      rule_id?: string
    }
    expect(body.model).toBe('text-embedding-3-small')
    expect(body.rule_id).toBeUndefined()
  })

  it('throws when routing rule response is missing a model from non-json body', async () => {
    vi.resetModules()
    mockEnv.LLM_MODEL_EMBEDDING = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { data: {} })),
    )
    const { llmCreateEmbeddings: embed } = await import('./llm-client')
    await expect(embed({ userId: 'u1', input: 'hi' })).rejects.toThrow(/missing a model/)
  })

  it('throws when routing rule response is missing a model', async () => {
    vi.resetModules()
    mockEnv.LLM_MODEL_EMBEDDING = ''
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: true,
            status: 200,
            text: async () => 'not json at all',
          }) as unknown as Response,
      ),
    )
    const { llmCreateEmbeddings: embed } = await import('./llm-client')
    await expect(embed({ userId: 'u1', input: 'hi' })).rejects.toThrow(/missing a model/)
  })
})

describe('llmChatCompletion model override (AI Co-workers C2: only vetted pool models)', () => {
  const platformEnv = mockEnv as Record<string, string | undefined>
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_API_KEY = 'key-1'
    companyPicks.chat = null
    Object.assign(platformEnv, {
      PLATFORM_LLM_BASE_URL: 'https://openrouter.example/api/v1',
      PLATFORM_LLM_API_KEY: 'service-openrouter-key',
      PLATFORM_LLM_MODEL_CHAT: 'openai/gpt-5-mini',
      PLATFORM_LLM_MODEL_EMBEDDING: 'qwen/qwen3-embedding-8b',
    })
  })

  afterEach(async () => {
    for (const name of ['PLATFORM_LLM_BASE_URL', 'PLATFORM_LLM_API_KEY', 'PLATFORM_LLM_MODEL_CHAT', 'PLATFORM_LLM_MODEL_EMBEDDING']) {
      delete platformEnv[name]
    }
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
  })

  function okFetch() {
    const fetchMock = vi.fn(async () =>
      response(true, 200, {
        usage: { prompt_tokens: 3, completion_tokens: 2 },
        choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('on eigenInference a pool chat model wins over the company chat slot, and the call is logged to its caller', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(false)
    const fetchMock = okFetch()
    await llmChatCompletion({
      userId: 'coworker-1',
      messages: [{ role: 'user', content: 'hi' }],
      modelOverride: 'anthropic/claude-sonnet-5.5',
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { model: string }
    expect(body.model).toBe('anthropic/claude-sonnet-5.5')
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'coworker-1',
      expect.objectContaining({ operation: 'llm.chat.chat.success(attempt=1)' }),
    )
  })

  it('a model outside the pool fails loud before any request (eigenInference)', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(false)
    const fetchMock = okFetch()
    const call = llmChatCompletion({
      userId: 'coworker-1',
      messages: [{ role: 'user', content: 'hi' }],
      modelOverride: 'vendor/unvetted-model',
    })
    await expect(call).rejects.toBeInstanceOf(ModelNotInPoolError)
    await expect(call).rejects.toThrow(/"vendor\/unvetted-model" is not in the model pool for the chat slot/)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logActivityCallMock).not.toHaveBeenCalled()
  })

  it('a pool model of another slot is no chat override either', async () => {
    const fetchMock = okFetch()
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }], modelOverride: 'qwen/qwen3-asr-1.7b' }),
    ).rejects.toBeInstanceOf(ModelNotInPoolError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the same check holds on a bring-your-own-key provider outside the pool namespace (EUrouter)', async () => {
    const fetchMock = okFetch()
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }], modelOverride: 'vendor/unvetted-model' }),
    ).rejects.toBeInstanceOf(ModelNotInPoolError)
    expect(fetchMock).not.toHaveBeenCalled()
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }], modelOverride: 'qwen/qwen3.8-flash' })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { model: string }
    expect(body.model).toBe('qwen/qwen3.8-flash')
  })

  it('a blank override is refused, never read as "no override"', async () => {
    const fetchMock = okFetch()
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }], modelOverride: '  ' }),
    ).rejects.toBeInstanceOf(ModelNotInPoolError)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('openai/gpt-5-mini omits temperature even when caller passes temperature: 0', async () => {
    const fetchMock = okFetch()
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hi' }],
      modelOverride: 'openai/gpt-5-mini',
      temperature: 0,
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as Record<string, unknown>
    expect(body.model).toBe('openai/gpt-5-mini')
    expect('temperature' in body).toBe(false)
    expect(body.temperature).toBeUndefined()
  })

  it('openai/gpt-5-mini omits temperature when resolved from company chat slot as well', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(false)
    companyPicks.chat = 'openai/gpt-5-mini'
    const fetchMock = okFetch()
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0,
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as Record<string, unknown>
    expect(body.model).toBe('openai/gpt-5-mini')
    expect('temperature' in body).toBe(false)
  })

  it('DeepSeek keeps temperature: 0 when passed', async () => {
    const fetchMock = okFetch()
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hi' }],
      modelOverride: '~deepseek/deepseek-flash-latest',
      temperature: 0,
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as Record<string, unknown>
    expect(body.model).toBe('~deepseek/deepseek-flash-latest')
    expect(body.temperature).toBe(0)
  })
})

describe('llmChatCompletion attachments (files the model reads)', () => {
  const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg=='
  const PDF_B64 = 'JVBERi0xLjcKJcOkw7zDtsOf'

  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_API_KEY = 'key-1'
  })

  function okFetch() {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { choices: [{ message: { role: 'assistant', content: '{}' } }] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    return fetchMock
  }

  it('sends a user message with attachments as OpenAI content parts: text, image_url, file', async () => {
    const fetchMock = okFetch()
    await llmChatCompletion({
      userId: 'u1',
      messages: [
        { role: 'system', content: 'You read brand guides.' },
        {
          role: 'user',
          content: 'Here is the guide.',
          attachments: [
            { type: 'image', mime: 'image/png', base64: PNG_B64 },
            { type: 'pdf', filename: 'guide.pdf', base64: PDF_B64 },
          ],
        },
      ],
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      messages: Array<{ role: string; content: unknown }>
    }
    expect(body.messages[0]).toEqual({ role: 'system', content: 'You read brand guides.' })
    expect(body.messages[1]).toEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Here is the guide.' },
        { type: 'image_url', image_url: { url: `data:image/png;base64,${PNG_B64}` } },
        {
          type: 'file',
          file: { filename: 'guide.pdf', file_data: `data:application/pdf;base64,${PDF_B64}` },
        },
      ],
    })
    expect(body.messages[1]).not.toHaveProperty('attachments')
  })

  it('leaves messages without attachments exactly as before (string content)', async () => {
    const fetchMock = okFetch()
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { messages: unknown[] }
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
  })

  it('never sends the file bytes to analytics or the activity log — only what was attached', async () => {
    okFetch()
    await llmChatCompletion({
      userId: 'u1',
      messages: [
        {
          role: 'user',
          content: 'Here is the guide.',
          attachments: [{ type: 'pdf', filename: 'guide.pdf', base64: PDF_B64 }],
        },
      ],
    })
    const captured = JSON.stringify(captureServerEventMock.mock.calls)
    const logged = JSON.stringify(logActivityCallMock.mock.calls)
    expect(captured).not.toContain(PDF_B64)
    expect(logged).not.toContain(PDF_B64)
    expect(captureServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          $ai_input: [
            {
              role: 'user',
              content: 'Here is the guide.',
              attachments: [{ type: 'pdf', filename: 'guide.pdf', bytes: 18 }],
            },
          ],
        }),
      }),
    )
  })

  it('refuses attachments on a non-user message before any request (fail loud)', async () => {
    const fetchMock = okFetch()
    await expect(
      llmChatCompletion({
        userId: 'u1',
        messages: [
          {
            role: 'system',
            content: 'x',
            attachments: [{ type: 'image', mime: 'image/png', base64: PNG_B64 }],
          },
        ],
      }),
    ).rejects.toThrow(/attachments.*user message.*system/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('llmCreateTranscription', () => {
  const platformEnv = mockEnv as Record<string, string | undefined>
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1'
    mockEnv.OPENROUTER_API_KEY = 'openrouter-key'
    // eigenInference on this server: the hosting's endpoint and per-company key
    Object.assign(platformEnv, {
      PLATFORM_LLM_BASE_URL: 'https://openrouter.example/api/v1',
      PLATFORM_LLM_API_KEY: 'service-openrouter-key',
      PLATFORM_LLM_MODEL_CHAT: 'openai/gpt-5-mini',
      PLATFORM_LLM_MODEL_EMBEDDING: 'qwen/qwen3-embedding-8b',
    })
  })

  afterEach(() => {
    for (const name of ['PLATFORM_LLM_BASE_URL', 'PLATFORM_LLM_API_KEY', 'PLATFORM_LLM_MODEL_CHAT', 'PLATFORM_LLM_MODEL_EMBEDDING']) {
      delete platformEnv[name]
    }
  })

  it('BYOK uses saved OpenRouter credentials for speech-to-text', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    const fetchMock = vi.fn(async () =>
      response(true, 200, { text: 'from db', usage: { cost: 0.001 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    getDbMock.mockReturnValueOnce({
      select: () => ({
        from: () => ({
          where: () => ({
            limit: () =>
              Promise.resolve([
                {
                  provider: 'openrouter',
                  baseUrl: 'https://db-openrouter.example/api/v1',
                  apiKey: 'db-key',
                  apiKeyEncrypted: null,
                  ruleChat: null,
                  ruleEmbedding: null,
                  modelChat: null,
                  modelEmbedding: null,
                },
              ]),
          }),
        }),
      }),
    })
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(String(fetchMockUrl(fetchMock, 0))).toBe(
      'https://db-openrouter.example/api/v1/audio/transcriptions',
    )
    const auth = fetchMockInit(fetchMock, 0)?.headers as Record<string, string>
    expect(auth.Authorization).toBe('Bearer db-key')
  })

  it('BYOK falls back to OPENROUTER_* env when no DB credentials', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    const fetchMock = vi.fn(async () =>
      response(true, 200, { text: 'from env', usage: { cost: 0.001 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(String(fetchMockUrl(fetchMock, 0))).toBe(
      'https://openrouter.example/api/v1/audio/transcriptions',
    )
  })

  it('eigenInference speech-to-text runs on the platform AI key', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(false)
    const fetchMock = vi.fn(async () =>
      response(true, 200, { text: 'platform', usage: { cost: 0.001 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(String(fetchMockUrl(fetchMock, 0))).toBe(
      'https://openrouter.example/api/v1/audio/transcriptions',
    )
    const auth = fetchMockInit(fetchMock, 0)?.headers as Record<string, string>
    expect(auth.Authorization).toBe('Bearer service-openrouter-key')
  })

  it('posts audio to OpenRouter /audio/transcriptions', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { text: 'hello', usage: { cost: 0.001 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    const out = await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1, 2, 3]), format: 'webm', language: 'en' },
    })
    expect((out as { text: string }).text).toBe('hello')
    const url = fetchMockUrl(fetchMock, 0)
    expect(String(url)).toBe('https://openrouter.example/api/v1/audio/transcriptions')
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      model: string
      input_audio: { data: string; format: string }
      language: string
    }
    expect(body.model).toBe('qwen/qwen3-asr-1.7b')
    expect(body.input_audio.format).toBe('webm')
    expect(body.language).toBe('en')
    expect(body.input_audio.data).toBe(Buffer.from([1, 2, 3]).toString('base64'))
  })

  it('passes the vocabulary prompt to OpenAI through the provider passthrough, never as a forced language', async () => {
    const fetchMock = vi.fn(async () => response(true, 200, { text: 'hallo', usage: { cost: 0.001 } }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm', prompt: 'Names that may come up: Ony.' },
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as Record<string, unknown>
    expect(body.provider).toEqual({ options: { openai: { prompt: 'Names that may come up: Ony.' } } })
    expect(body).not.toHaveProperty('language')
    expect(body).not.toHaveProperty('prompt')
  })

  it('no prompt: no provider options at all', async () => {
    const fetchMock = vi.fn(async () => response(true, 200, { text: 'x', usage: { cost: 0.001 } }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as Record<string, unknown>
    expect(body).not.toHaveProperty('provider')
  })

  it('logs STT cost from usage.cost in activity (eigenInference: provider platform)', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { text: 'hello', usage: { cost: 0.0035 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1, 2, 3]), format: 'webm' },
    })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        provider: 'platform',
        operation: expect.stringContaining('llm.stt.success'),
        baseCostUsd: 0.0035,
        gatewayHost: 'openrouter.example',
      }),
    )
  })

  it('STT retries on HTTP error then succeeds', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(false, 503, { error: 'busy' }))
      .mockResolvedValueOnce(response(true, 200, { text: 'retry ok', usage: { cost: 0.001 } }))
    vi.stubGlobal('fetch', fetchMock)
    const out = await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect((out as { text: string }).text).toBe('retry ok')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ operation: expect.stringContaining('llm.stt.error(attempt=1') }),
    )
  })

  it('STT fails after three HTTP errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 502, { error: 'bad gateway' })),
    )
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/LLM STT HTTP 502/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('STT handles non-json error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({
            ok: false,
            status: 400,
            text: async () => 'invalid audio',
          }) as unknown as Response,
      ),
    )
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/LLM STT HTTP 400/)
  })

  it('STT throws fallback error when fetch rejects non-error value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Promise.reject('stt-boom')),
    )
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/failed after 3 attempts/)
  })

  it('STT parses transcript from choices message content', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, {
        choices: [{ message: { content: 'from choices' } }],
        usage: { cost: 0.002 },
      }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ context: 'from choices' }),
    )
  })

  it('STT uses transcript preview context when cost is present but text field is absent', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          choices: [{ message: { content: 'heard this' } }],
          usage: { cost: 0.002 },
        }),
      ),
    )
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ context: 'heard this', baseCostUsd: 0.002 }),
    )
  })

  it('STT logs fallback context when transcript text is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { usage: {} })),
    )
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        context: 'stt:qwen/qwen3-asr-1.7b (usage cost missing from gateway)',
      }),
    )
  })

  it('BYOK STT fails when OPENROUTER_BASE_URL is missing', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    mockEnv.OPENROUTER_BASE_URL = ''
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/OPENROUTER_BASE_URL/)
  })

  it('BYOK STT fails when OPENROUTER_API_KEY is missing', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    mockEnv.OPENROUTER_API_KEY = ''
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/OPENROUTER_API_KEY/)
  })

  it('eigenInference STT without PLATFORM_LLM_* fails loud; a leftover SERVICE_API_KEY_OPENROUTER is never read', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(false)
    delete platformEnv.PLATFORM_LLM_BASE_URL
    delete platformEnv.PLATFORM_LLM_API_KEY
    delete platformEnv.PLATFORM_LLM_MODEL_CHAT
    delete platformEnv.PLATFORM_LLM_MODEL_EMBEDDING
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-openrouter-key'
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/eigenInference is not connected on this server/)
  })

  it('STT aborts when LLM_REQUEST_TIMEOUT_MS elapses', async () => {
    mockEnv.LLM_REQUEST_TIMEOUT_MS = '1'
    vi.stubGlobal('fetch', fetchThatWaitsForAbort())
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/LLM STT request timed out after 1ms/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

describe('llm client: no self-hosted service account (removed in CB1)', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    // the removed pairs, still set on an old server: never read
    mockEnv.SERVICE_API_KEY_EUROUTER = 'service-eurouter-key'
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-openrouter-key'
    mockEnv.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1'
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(false)
  })

  it('eigenInference without PLATFORM_LLM_* fails loud, telling the owner what to do, and sends nothing', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const chat = llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    await expect(chat).rejects.toBeInstanceOf(LlmNotConfiguredError)
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/eigenInference is not connected on this server/)
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'x' })).rejects.toThrow(/eigenInference is not connected/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the message never names the removed env pairs ("Platform EUrouter not configured" is gone by design)', async () => {
    mockSequentialDbLimitResults([{ provider: 'openrouter' }])
    const err = await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] }).catch((e: unknown) => e)
    expect(String(err)).not.toMatch(/SERVICE_API_KEY|LLM_BASE_URL|OPENROUTER_BASE_URL|Platform EUrouter/)
  })
})

describe('llm client platform AI from hosting (PLATFORM_LLM_*)', () => {
  const PLATFORM_AI = {
    PLATFORM_LLM_BASE_URL: 'https://platform-llm.example/api/v1/',
    PLATFORM_LLM_API_KEY: 'sk-platform',
    PLATFORM_LLM_MODEL_CHAT: 'openai/gpt-5-mini',
    PLATFORM_LLM_MODEL_EMBEDDING: 'openai/text-embedding-3-small',
  }
  const env = mockEnv as Record<string, string | undefined>

  beforeEach(async () => {
    vi.clearAllMocks()
    mockSequentialDbLimitResults()
    // A hosted box: the platform AI only, no service-account keys.
    mockEnv.LLM_BASE_URL = ''
    mockEnv.LLM_API_KEY = ''
    mockEnv.SERVICE_API_KEY_EUROUTER = ''
    mockEnv.SERVICE_API_KEY_OPENROUTER = ''
    mockEnv.LLM_MODEL_CHAT = ''
    mockEnv.LLM_MODEL_EMBEDDING = ''
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    Object.assign(env, PLATFORM_AI)
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(false)
  })

  afterEach(() => {
    for (const name of Object.keys(PLATFORM_AI)) delete env[name]
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_API_KEY = 'key-1'
    mockEnv.SERVICE_API_KEY_EUROUTER = 'service-eurouter-key'
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-openrouter-key'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_MODEL_EMBEDDING = 'text-embedding-3-small'
  })

  it('eigenInference chat goes to the platform AI endpoint with its key and the company chat slot (PLATFORM_LLM_MODEL_CHAT is not read), cost logged', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1, cost: 0.0042 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchMockUrl(fetchMock, 0)).toBe('https://platform-llm.example/api/v1/chat/completions')
    const init = fetchMockInit(fetchMock, 0)
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer sk-platform')
    const body = JSON.parse(String(init?.body)) as { model?: string; rule_id?: string }
    expect(body.model).toBe('~deepseek/deepseek-flash-latest')
    expect(body.rule_id).toBeUndefined()
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        provider: 'platform',
        gatewayHost: 'platform-llm.example',
        baseCostUsd: 0.0042,
      }),
    )
  })

  it('the platform AI is the platform path even when the active-provider row says openrouter', async () => {
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-openrouter-key'
    mockSequentialDbLimitResults([{ provider: 'openrouter' }])
    const fetchMock = vi.fn(async () => response(true, 200, { usage: { cost: 0.001 }, choices: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchMockUrl(fetchMock, 0)).toBe('https://platform-llm.example/api/v1/chat/completions')
    expect((fetchMockInit(fetchMock, 0)?.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-platform',
    )
  })

  it('embeddings pin the embedding model the hosting provisioned (PLATFORM_LLM_MODEL_EMBEDDING)', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { data: [{ embedding: [0.1, 0.2] }], usage: { cost: 0.0001 } }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })
    expect(fetchMockUrl(fetchMock, 0)).toBe('https://platform-llm.example/api/v1/embeddings')
    const body = JSON.parse(String(fetchMockInit(fetchMock, 0)?.body)) as { model?: string }
    expect(body.model).toBe('openai/text-embedding-3-small')
  })

  it('describes the platform AI as the chat model (billing platform)', async () => {
    await expect(describeChatModel('u1')).resolves.toEqual({
      provider: 'platform',
      model: '~deepseek/deepseek-flash-latest',
      routingRuleId: null,
      billing: 'platform',
      gatewayHost: 'platform-llm.example',
    })
  })

  it('a user who chose BYOK still runs on their own key, not the platform AI', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    mockEnv.LLM_BASE_URL = 'https://byok-gw.example/v1'
    mockEnv.LLM_API_KEY = 'byok-key'
    mockEnv.LLM_MODEL_CHAT = 'byok-model'
    const fetchMock = vi.fn(async () => response(true, 200, { choices: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchMockUrl(fetchMock, 0)).toBe('https://byok-gw.example/v1/chat/completions')
    expect((fetchMockInit(fetchMock, 0)?.headers as Record<string, string>).Authorization).toBe(
      'Bearer byok-key',
    )
  })

  it('platform credits speech-to-text runs on the platform AI key (a hosted box has no service account), cost logged as platform', async () => {
    mockEnv.OPENROUTER_BASE_URL = ''
    const fetchMock = vi.fn(async () => response(true, 200, { text: 'hallo', usage: { cost: 0.00007 } }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(fetchMockUrl(fetchMock, 0)).toBe('https://platform-llm.example/api/v1/audio/transcriptions')
    expect((fetchMockInit(fetchMock, 0)?.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-platform',
    )
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ provider: 'platform', gatewayHost: 'platform-llm.example' }),
    )
    mockEnv.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1'
  })

  it('the platform AI wins over a service-account key for speech too', async () => {
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-openrouter-key'
    const fetchMock = vi.fn(async () => response(true, 200, { text: 'x', usage: { cost: 0.001 } }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect((fetchMockInit(fetchMock, 0)?.headers as Record<string, string>).Authorization).toBe(
      'Bearer sk-platform',
    )
  })

  it('a partial platform AI fails speech loud too, never the service account', async () => {
    delete env.PLATFORM_LLM_API_KEY
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-openrouter-key'
    vi.stubGlobal('fetch', vi.fn())
    await expect(
      llmCreateTranscription({
        userId: 'u1',
        audio: { bytes: new Uint8Array([1]), format: 'webm' },
      }),
    ).rejects.toThrow(/PLATFORM_LLM_API_KEY is not set/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('a partial platform AI fails loud instead of falling back to another path', async () => {
    delete env.PLATFORM_LLM_MODEL_CHAT
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.SERVICE_API_KEY_EUROUTER = 'service-eurouter-key'
    vi.stubGlobal('fetch', vi.fn())
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/PLATFORM_LLM_MODEL_CHAT is not set/)
    expect(fetch).not.toHaveBeenCalled()
  })
})

describe('llm client BYOK DB credentials', () => {
  beforeEach(async () => {
    vi.clearAllMocks()
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
  })

  it('loads encrypted api key from DB via decryptTenantValue', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    mockSequentialDbLimitResults(
      [{ provider: 'eurouter' }],
      [
        {
          provider: 'eurouter',
          baseUrl: 'https://db-gateway.example/v1',
          apiKey: 'placeholder',
          apiKeyEncrypted: 'enc-blob',
          ruleChat: 'db-rule-chat',
          ruleEmbedding: 'db-rule-embed',
          modelChat: 'db-chat-model',
          modelEmbedding: 'db-embed-model',
        },
      ],
    )
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    expect(decryptTenantValueMock).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', ciphertext: 'enc-blob' }),
    )
    const auth = fetchMockInit(fetchMock, 0)?.headers as Record<string, string>
    expect(auth.Authorization).toBe('Bearer decrypted-key')
    expect(String(fetchMockUrl(fetchMock, 0))).toBe(
      'https://db-gateway.example/v1/chat/completions',
    )
  })

  it('falls back to env credentials when DB row is incomplete', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    mockEnv.LLM_BASE_URL = 'https://env-gateway.example/v1'
    mockEnv.LLM_API_KEY = 'env-key'
    mockSequentialDbLimitResults(
      [{ provider: 'eurouter' }],
      [
        {
          provider: 'eurouter',
          baseUrl: null,
          apiKey: 'db-key',
          apiKeyEncrypted: null,
          ruleChat: 'rule-chat',
          ruleEmbedding: 'rule-embed',
          modelChat: null,
          modelEmbedding: null,
        },
      ],
    )
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    expect(String(fetchMockUrl(fetchMock, 0))).toBe(
      'https://env-gateway.example/v1/chat/completions',
    )
  })

  it('rejects Docker placeholder base URL from DB eurouter credentials', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    mockSequentialDbLimitResults(
      [{ provider: 'eurouter' }],
      [
        {
          provider: 'eurouter',
          baseUrl: 'https://example.com/v1',
          apiKey: 'db-key',
          apiKeyEncrypted: null,
          ruleChat: 'rule-chat',
          ruleEmbedding: 'rule-embed',
          modelChat: null,
          modelEmbedding: null,
        },
      ],
    )
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/Docker placeholder/)
  })
})

describe('llm client OpenRouter routing (an OpenRouter key runs the company slots)', () => {
  function openRouterRow(overrides: Record<string, unknown> = {}) {
    return {
      provider: 'openrouter',
      baseUrl: 'https://db-openrouter.example/api/v1',
      apiKey: 'db-key',
      apiKeyEncrypted: null,
      ruleChat: null,
      ruleEmbedding: null,
      modelChat: null,
      modelEmbedding: null,
      ...overrides,
    }
  }

  beforeEach(async () => {
    vi.clearAllMocks()
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_MODEL_CHAT = ''
    mockEnv.LLM_MODEL_EMBEDDING = ''
    companyPicks.chat = null
    pinnedEmbedding.model = null
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
  })

  afterEach(() => {
    companyPicks.chat = null
    pinnedEmbedding.model = null
  })

  it("chat sends the company's chat slot, not the credential's saved free-text model", async () => {
    mockSequentialDbLimitResults([{ provider: 'openrouter' }], [openRouterRow({ modelChat: 'openrouter/chat-model' })])
    const fetchMock = vi.fn(async () => response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { model: string; rule_id?: string }
    expect(body.model).toBe('~deepseek/deepseek-flash-latest')
    expect(body.rule_id).toBeUndefined()
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ provider: 'openrouter', gatewayHost: 'db-openrouter.example' }),
    )
  })

  it('chat sends the model the company picked for the slot', async () => {
    companyPicks.chat = 'openai/gpt-5-mini'
    mockSequentialDbLimitResults([{ provider: 'openrouter' }], [openRouterRow()])
    const fetchMock = vi.fn(async () => response(true, 200, { choices: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    expect((JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { model: string }).model).toBe('openai/gpt-5-mini')
  })

  it('a pick that left the pool fails loud instead of running something else', async () => {
    companyPicks.chat = 'vendor/retired-model'
    mockSequentialDbLimitResults([{ provider: 'openrouter' }], [openRouterRow()])
    await expect(
      llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] }),
    ).rejects.toThrow(/not in the model pool for the chat slot/)
  })

  it('embeddings keep the model the install embedded with so far (pinned once), when it is in the pool', async () => {
    mockSequentialDbLimitResults(
      [{ provider: 'openrouter' }],
      [openRouterRow({ modelEmbedding: 'openai/text-embedding-3-small' })],
    )
    const fetchMock = vi.fn(async () => response(true, 200, { usage: { total_tokens: 1 }, data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { model: string }
    expect(body.model).toBe('openai/text-embedding-3-small')
  })

  it('embeddings with no model anywhere pin the pool’s pick', async () => {
    mockSequentialDbLimitResults([{ provider: 'openrouter' }], [openRouterRow()])
    const fetchMock = vi.fn(async () => response(true, 200, { usage: { total_tokens: 1 }, data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })
    expect((JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { model: string }).model).toBe(
      'qwen/qwen3-embedding-8b',
    )
  })

  it('a pinned embedding model wins over whatever the key has saved', async () => {
    pinnedEmbedding.model = 'qwen/qwen3-embedding-8b'
    mockSequentialDbLimitResults(
      [{ provider: 'openrouter' }],
      [openRouterRow({ modelEmbedding: 'openai/text-embedding-3-small' })],
    )
    const fetchMock = vi.fn(async () => response(true, 200, { usage: { total_tokens: 1 }, data: [] }))
    vi.stubGlobal('fetch', fetchMock)
    await llmCreateEmbeddings({ userId: 'u1', input: 'hello' })
    expect((JSON.parse(fetchMockInit(fetchMock, 0).body as string) as { model: string }).model).toBe(
      'qwen/qwen3-embedding-8b',
    )
  })

  it('an embedding model outside the pool fails loud on the first resolution (no silent re-embedding)', async () => {
    mockSequentialDbLimitResults([{ provider: 'openrouter' }], [openRouterRow({ modelEmbedding: 'openrouter/embed-model' })])
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /not in the model pool for the embedding slot/,
    )
  })
})

describe('llm client response parsing and options', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_RULE_EMBEDDING = 'rule-embed'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_MODEL_EMBEDDING = 'text-embedding-3-small'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_API_KEY = 'key-1'
  })

  it('chat includes maxTokens when provided', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
      maxTokens: 256,
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      max_tokens?: number
    }
    expect(body.max_tokens).toBe(256)
  })

  it('chat sends a bounded default max_tokens when omitted (avoids full-context reservation)', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
    })
    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      max_tokens?: number
    }
    expect(body.max_tokens).toBe(DEFAULT_CHAT_MAX_TOKENS)
    expect(DEFAULT_CHAT_MAX_TOKENS).toBeLessThan(100_000)
  })

  it('chat logs empty response text for non-text message content', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          usage: { prompt_tokens: 1 },
          choices: [{ message: { content: { notText: true } } }],
        }),
      ),
    )
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
      logContext: 'non-text',
    })
    expect(logSpy).toHaveBeenCalledWith('[llm.chat:non-text] response attempt 1:\n')
    logSpy.mockRestore()
  })

  it('chat logs array content parts from gateway response', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          usage: { prompt_tokens: 1 },
          choices: [
            {
              message: {
                content: [{ text: 'part-one' }, 'part-two', { text: 42 }, null],
              },
            },
          ],
        }),
      ),
    )
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
      logContext: 'parse test',
    })
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('[llm.chat:parse_test] response attempt 1:\npart-onepart-two'),
    )
    logSpy.mockRestore()
  })

  it('chat succeeds on second attempt after first failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(false, 429, { error: 'rate limited' }))
      .mockResolvedValueOnce(
        response(true, 200, {
          usage: { prompt_tokens: 1 },
          choices: [{ message: { content: 'ok' } }],
        }),
      )
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ operation: 'llm.chat.chat.error(attempt=1)' }),
    )
  })

  it('chat uses empty context when no user message is present', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] })),
    )
    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'system', content: 'system only' }],
    })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ context: '' }),
    )
  })

  it('embedding logs and previews array input', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { usage: { total_tokens: 2 }, data: [] })),
    )
    await llmCreateEmbeddings({
      userId: 'u1',
      input: ['short', 'x'.repeat(200)],
    })
    expect(logSpy).toHaveBeenCalledWith('[llm.embedding] input[0]: short')
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringMatching(/\[llm\.embedding\] input\[1\]: x+\.\.\./),
    )
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ context: 'short' }),
    )
    logSpy.mockRestore()
  })

  it('chat routing rule lookup is cached on second call', async () => {
    vi.resetModules()
    mockEnv.LLM_MODEL_CHAT = ''
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(true, 200, { data: { model: 'cached-rule-model' } }))
      .mockResolvedValueOnce(response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }))
      .mockResolvedValueOnce(response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const { llmChatCompletion: chat } = await import('./llm-client')
    await chat({ userId: 'u1', messages: [{ role: 'user', content: 'one' }] })
    await chat({ userId: 'u1', messages: [{ role: 'user', content: 'two' }] })
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(String(fetchMockUrl(fetchMock, 0))).toContain('/routing-rules/rule-chat')
  })

  it('chat logs error context as empty when no user message exists', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(response(false, 500, { error: 'down' }))
      .mockResolvedValueOnce(response(false, 500, { error: 'down' }))
      .mockResolvedValueOnce(response(false, 500, { error: 'down' }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(
      llmChatCompletion({
        userId: 'u1',
        messages: [{ role: 'assistant', content: 'prior answer' }],
      }),
    ).rejects.toThrow(/LLM HTTP 500/)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ operation: 'llm.chat.chat.error(attempt=1)', context: '' }),
    )
  })

  it('embedding logs array input preview on error attempts', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 500, { error: 'down' })),
    )
    await expect(llmCreateEmbeddings({ userId: 'u1', input: ['alpha', 'beta'] })).rejects.toThrow(
      /LLM HTTP 500/,
    )
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ operation: 'llm.embedding.error(attempt=1)', context: 'alpha' }),
    )
  })

  it('chat includes provider from routing rule lookup', async () => {
    vi.resetModules()
    mockEnv.LLM_MODEL_CHAT = ''
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        response(true, 200, {
          model: 'direct-model',
          provider: { data_residency: 'EU' },
        }),
      )
      .mockResolvedValueOnce(response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }))
    vi.stubGlobal('fetch', fetchMock)
    const { llmChatCompletion: chat } = await import('./llm-client')
    await chat({ userId: 'u1', messages: [{ role: 'user', content: 'hi' }] })
    const body = JSON.parse(fetchMockInit(fetchMock, 1).body as string) as {
      model: string
      provider?: Record<string, unknown>
    }
    expect(body.model).toBe('direct-model')
    expect(body.provider).toEqual({ data_residency: 'EU' })
  })
})

describe('llm client timeout and rate limit defaults', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_API_KEY = 'key-1'
  })

  it('aborts chat request when LLM_REQUEST_TIMEOUT_MS elapses', async () => {
    mockEnv.LLM_REQUEST_TIMEOUT_MS = '1'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    vi.stubGlobal('fetch', fetchThatWaitsForAbort())
    await expect(
      llmChatCompletion({
        userId: 'u1',
        messages: [{ role: 'user', content: 'hello' }],
      }),
    ).rejects.toThrow(/LLM request timed out after 1ms/)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('aborts embedding request when LLM_REQUEST_TIMEOUT_MS elapses', async () => {
    mockEnv.LLM_REQUEST_TIMEOUT_MS = '1'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_MODEL_EMBEDDING = 'text-embedding-3-small'
    mockEnv.LLM_RULE_EMBEDDING = 'rule-embed'
    vi.stubGlobal('fetch', fetchThatWaitsForAbort())
    await expect(llmCreateEmbeddings({ userId: 'u1', input: 'hello' })).rejects.toThrow(
      /LLM embedding request timed out after 1ms/,
    )
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('logs embedding request for a single string input', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { usage: { total_tokens: 2 }, data: [] })),
    )
    await llmCreateEmbeddings({ userId: 'u1', input: 'x'.repeat(120) })
    expect(logSpy).toHaveBeenCalledWith(expect.stringMatching(/\[llm\.embedding\] input: x+\.\.\./))
    logSpy.mockRestore()
  })

  it('logs STT response when body is empty', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, null)),
    )
    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
    })
    expect(logSpy).toHaveBeenCalledWith('[llm.stt] response attempt 1: (empty response)')
    logSpy.mockRestore()
  })

  it('uses default 1000ms rate limit when env var is empty', async () => {
    vi.resetModules()
    vi.useFakeTimers()
    try {
      mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = ''
      mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] })),
      )
      const { llmChatCompletion: chat } = await import('./llm-client')
      const first = chat({ userId: 'u-rate', messages: [{ role: 'user', content: 'a' }] })
      await vi.advanceTimersByTimeAsync(0)
      const second = chat({ userId: 'u-rate', messages: [{ role: 'user', content: 'b' }] })
      await vi.advanceTimersByTimeAsync(1000)
      await first
      await second
      expect(fetch).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('llm client tool-calling passthrough', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_API_KEY = 'key-1'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
  })

  const chatTools = [
    {
      type: 'function',
      function: {
        name: 'memory.search',
        description: 'Search company memory.',
        parameters: { type: 'object', properties: { query: { type: 'string' } } },
      },
    },
  ]

  it('carries tools and tool_choice in the request body when given', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
      tools: chatTools,
      toolChoice: 'auto',
    })

    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      tools?: unknown
      tool_choice?: unknown
    }
    expect(body.tools).toEqual(chatTools)
    expect(body.tool_choice).toBe('auto')
  })

  it('omits tools and tool_choice from the body when not given', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'hello' }],
    })

    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      tools?: unknown
      tool_choice?: unknown
    }
    expect('tools' in body).toBe(false)
    expect('tool_choice' in body).toBe(false)
  })

  it('returns a tool_calls response as-is and still logs the call', async () => {
    const toolCallsBody = {
      usage: { prompt_tokens: 21, completion_tokens: 5, total_tokens: 26 },
      choices: [
        {
          finish_reason: 'tool_calls',
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: 'call_1',
                type: 'function',
                function: { name: 'memory.search', arguments: '{"query":"brand"}' },
              },
            ],
          },
        },
      ],
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, toolCallsBody)),
    )

    const raw = await llmChatCompletion({
      userId: 'u1',
      messages: [{ role: 'user', content: 'find brand notes' }],
      tools: chatTools,
      logContext: 'durable-agent',
    })

    expect(raw).toEqual(toolCallsBody)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        operation: 'llm.chat.durable-agent.success(attempt=1)',
        gatewayHost: 'example.test',
      }),
    )
  })

  it('passes tool-role and assistant tool_calls messages through verbatim', async () => {
    const fetchMock = vi.fn(async () =>
      response(true, 200, { usage: { prompt_tokens: 1 }, choices: [] }),
    )
    vi.stubGlobal('fetch', fetchMock)

    await llmChatCompletion({
      userId: 'u1',
      messages: [
        { role: 'system', content: 'system prompt' },
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: '',
          tool_calls: [
            {
              id: 'call_9',
              type: 'function',
              function: { name: 'memory.search', arguments: '{"query":"x"}' },
            },
          ],
        },
        { role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_9' },
      ],
      tools: chatTools,
    })

    const body = JSON.parse(fetchMockInit(fetchMock, 0).body as string) as {
      messages: Array<{ role: string; content: string; tool_call_id?: string }>
    }
    expect(body.messages).toHaveLength(4)
    expect(body.messages[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [
        {
          id: 'call_9',
          type: 'function',
          function: { name: 'memory.search', arguments: '{"query":"x"}' },
        },
      ],
    })
    // role:'tool' + tool_call_id survive sanitize; JSON content is pretty-printed
    // by the existing embedding-strip sanitizer (equivalent JSON, reformatted).
    expect(body.messages[3]).toEqual({
      role: 'tool',
      content: '{\n  "status": "ok"\n}',
      tool_call_id: 'call_9',
    })
  })
})

/**
 * Memory text stays out of logs and analytics (Contribute 7fa15491). A call whose caller says
 * its text is a person's Memory (`contentOrigin: 'memory'`) keeps its cost, tokens, model and
 * timing — never the text: not in server logs, not in the AI usage log's preview, not in
 * PostHog's `$ai_generation`.
 */
describe('memory content stays out of logs, the AI usage log and PostHog', () => {
  const WORRY = 'I am afraid my cofounder wants to quit'
  const ANSWER = 'You sound worried about your cofounder'
  let consoleSpies: Array<ReturnType<typeof vi.spyOn>> = []

  function logged(): string {
    return JSON.stringify(consoleSpies.flatMap((spy) => spy.mock.calls))
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_RULE_EMBEDDING = 'rule-embed'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_MODEL_EMBEDDING = 'text-embedding-3-small'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_API_KEY = 'key-1'
    consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {}),
    )
  })

  afterEach(() => {
    for (const spy of consoleSpies) spy.mockRestore()
  })

  it('a memory chat keeps model, tokens and cost but no prompt or answer text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46, cost: 0.002 },
          choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: ANSWER } }],
        }),
      ),
    )

    await llmChatCompletion({
      userId: 'u1',
      messages: [
        { role: 'system', content: 'Summarise the thought.' },
        { role: 'user', content: WORRY },
      ],
      logContext: 'enrich',
      contentOrigin: 'memory',
    })

    expect(logged()).not.toContain(WORRY)
    expect(logged()).not.toContain(ANSWER)
    expect(JSON.stringify(logActivityCallMock.mock.calls)).not.toContain(WORRY)
    expect(JSON.stringify(captureServerEventMock.mock.calls)).not.toContain(WORRY)
    expect(JSON.stringify(captureServerEventMock.mock.calls)).not.toContain(ANSWER)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        operation: 'llm.chat.enrich.success(attempt=1)',
        baseCostUsd: 0.002,
        context: undefined,
      }),
    )
    const [event] = captureServerEventMock.mock.calls[0] as [
      { event: string; properties: Record<string, unknown> },
    ]
    expect(event.event).toBe('$ai_generation')
    expect(event.properties).toMatchObject({
      $ai_model: 'gpt-test',
      $ai_input_tokens: 12,
      $ai_output_tokens: 34,
      $ai_stop_reason: 'stop',
      $ai_latency: expect.any(Number),
    })
    expect(event.properties).not.toHaveProperty('$ai_input')
    expect(event.properties).not.toHaveProperty('$ai_output_choices')
  })

  it('a failing memory chat keeps the error but no prompt text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 500, { error: 'down' })),
    )

    await expect(
      llmChatCompletion({
        userId: 'u1',
        messages: [{ role: 'user', content: WORRY }],
        contentOrigin: 'memory',
      }),
    ).rejects.toThrow(/LLM HTTP 500/)

    expect(logged()).not.toContain(WORRY)
    expect(JSON.stringify(logActivityCallMock.mock.calls)).not.toContain(WORRY)
    expect(JSON.stringify(captureServerEventMock.mock.calls)).not.toContain(WORRY)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ operation: 'llm.chat.chat.error(attempt=3)', context: undefined }),
    )
    expect(captureServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({ $ai_is_error: true, $ai_model: 'gpt-test' }),
      }),
    )
    const [event] = captureServerEventMock.mock.calls[0] as [{ properties: object }]
    expect(event.properties).not.toHaveProperty('$ai_input')
  })

  it('other chats still keep their text for observability', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, {
          choices: [{ message: { role: 'assistant', content: ANSWER } }],
        }),
      ),
    )
    await llmChatCompletion({ userId: 'u1', messages: [{ role: 'user', content: 'hello' }] })
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({ context: 'hello' }),
    )
    expect(captureServerEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          $ai_input: [{ role: 'user', content: 'hello' }],
        }),
      }),
    )
  })

  it('a memory embedding keeps its cost but logs no input text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response(true, 200, { data: [{ embedding: [0.1] }], usage: { cost: 0.0001 } }),
      ),
    )

    await llmCreateEmbeddings({ userId: 'u1', input: [WORRY, 'second'], contentOrigin: 'memory' })

    expect(logged()).not.toContain(WORRY)
    expect(JSON.stringify(logActivityCallMock.mock.calls)).not.toContain(WORRY)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        operation: 'llm.embedding.success(attempt=1)',
        baseCostUsd: 0.0001,
        context: undefined,
      }),
    )
  })

  it('a failing memory embedding logs no input text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(false, 500, { error: 'down' })),
    )
    await expect(
      llmCreateEmbeddings({ userId: 'u1', input: WORRY, contentOrigin: 'memory' }),
    ).rejects.toThrow()
    expect(logged()).not.toContain(WORRY)
    expect(JSON.stringify(logActivityCallMock.mock.calls)).not.toContain(WORRY)
  })

  it('a memory voice note keeps its cost but logs no transcript', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(true, 200, { text: WORRY, usage: { cost: 0.003 } })),
    )

    await llmCreateTranscription({
      userId: 'u1',
      audio: { bytes: new Uint8Array([1]), format: 'webm' },
      contentOrigin: 'memory',
    })

    expect(logged()).not.toContain(WORRY)
    expect(JSON.stringify(logActivityCallMock.mock.calls)).not.toContain(WORRY)
    expect(logActivityCallMock).toHaveBeenCalledWith(
      expect.anything(),
      'u1',
      expect.objectContaining({
        baseCostUsd: 0.003,
        context: 'stt:qwen/qwen3-asr-1.7b',
      }),
    )
  })
})

describe('describeChatModel (what the gateway resolves for a chat call, no secrets)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_API_KEY = 'key-1'
    getDbMock.mockImplementation(() => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.from = () => chain
      chain.where = () => chain
      chain.limit = () => Promise.resolve([])
      return chain
    })
  })

  it('reports the provider, model, routing rule, billing and gateway host the chat call would use', async () => {
    const { isByokBilling } = await import('$lib/server/llm/preferences')
    vi.mocked(isByokBilling).mockResolvedValue(true)
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const described = await describeChatModel('u1')

    expect(described).toEqual({
      provider: 'eurouter',
      model: 'gpt-test',
      routingRuleId: 'rule-chat',
      billing: 'byok',
      gatewayHost: 'example.test',
    })
    expect(JSON.stringify(described)).not.toContain('key-1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

})

/**
 * DC3 (plan/phase-demo-company.md D2): the company's per-person daily AI cap is enforced at the
 * gateway boundary — every model call (chat, embeddings, speech) checks the person it is made
 * for before resolving a provider or sending anything. Owner and admins are exempt; an unset
 * cap caps nobody.
 */
describe('llm client: per-person daily AI cap (members)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.LLM_BASE_URL = 'https://example.test'
    mockEnv.LLM_RULE_CHAT = 'rule-chat'
    mockEnv.LLM_RULE_EMBEDDING = 'rule-embed'
    mockEnv.LLM_MODEL_CHAT = 'gpt-test'
    mockEnv.LLM_MODEL_EMBEDDING = 'text-embedding-3-small'
    mockEnv.LLM_MIN_REQUEST_INTERVAL_MS = '0'
    mockEnv.LLM_REQUEST_TIMEOUT_MS = ''
    mockEnv.LLM_API_KEY = 'key-1'
    capStore.cap = 1
    capStore.roles = { mia: 'member', ada: 'owner', ali: 'admin' }
    capStore.spent = {}
  })

  afterEach(() => {
    capStore.cap = null
    capStore.roles = {}
    capStore.spent = {}
  })

  const ok = () => vi.fn(async () => response(true, 200, { choices: [], data: [{ embedding: [0.1] }] }))

  it('a member under the cap gets the model call', async () => {
    capStore.spent = { mia: 0.5 }
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'mia', messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('a member over the cap is refused before anything is sent, once (no retries), with the plain message', async () => {
    capStore.spent = { mia: 1.2 }
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    const err = await llmChatCompletion({ userId: 'mia', messages: [{ role: 'user', content: 'hi' }] }).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(LlmDailyCapError)
    expect((err as Error).message).toBe(
      "You've used today's AI allowance for this company. It resets at midnight UTC.",
    )
    await expect(llmCreateEmbeddings({ userId: 'mia', input: 'x' })).rejects.toBeInstanceOf(LlmDailyCapError)
    await expect(
      llmCreateTranscription({ userId: 'mia', audio: { bytes: new Uint8Array([1]), format: 'wav' } }),
    ).rejects.toBeInstanceOf(LlmDailyCapError)
    await expect(llmCreateSpeech({ userId: 'mia', voice: 'alloy', text: 'hi' })).rejects.toBeInstanceOf(
      LlmDailyCapError,
    )
    expect(fetchMock).not.toHaveBeenCalled()
    expect(logActivityCallMock).not.toHaveBeenCalled()
  })

  it('the owner and admins are never capped', async () => {
    capStore.spent = { ada: 40, ali: 40 }
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'ada', messages: [{ role: 'user', content: 'hi' }] })
    await llmChatCompletion({ userId: 'ali', messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('an unset cap caps nobody', async () => {
    capStore.cap = null
    capStore.spent = { mia: 40 }
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    await llmChatCompletion({ userId: 'mia', messages: [{ role: 'user', content: 'hi' }] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('counts against the person the call is logged to (the tenant user), as the cost log does', async () => {
    capStore.spent = { mia: 2 }
    const fetchMock = ok()
    vi.stubGlobal('fetch', fetchMock)
    // Fresh instances of both (earlier specs reset the module graph): one AsyncLocalStorage.
    vi.resetModules()
    const { tenantUserAsyncLocal } = await import('$lib/server/db/tenant-context')
    const fresh = await import('./llm-client')
    const err = await tenantUserAsyncLocal
      .run('mia', () => fresh.llmChatCompletion({ userId: 'ada', messages: [{ role: 'user', content: 'hi' }] }))
      .catch((e: unknown) => e)
    expect((err as Error).name).toBe('LlmDailyCapError')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
