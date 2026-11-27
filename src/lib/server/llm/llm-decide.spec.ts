import { describe, expect, it, vi } from 'vitest'
import { mockDecision } from '../../../../scripts/mock-gateway-decisions.mjs'
import { LlmHttpError, LlmNotConfiguredError } from './errors'
import { DecisionOutOfSetError, decisionsUrl, llmDecide, type LlmDecideDeps } from './llm-decide'
import { ModelNotInPoolError } from './model-pool'
import type { SlotTarget } from './slots'

const target = (over: Partial<SlotTarget> = {}): SlotTarget => ({
  slot: 'decision',
  source: 'eigeninference',
  model: 'typesafe/jev-1.13',
  config: {
    provider: 'platform',
    baseUrl: 'https://inference.example/v1',
    apiKey: 'sk-secret-key',
    ruleChat: null,
    ruleEmbedding: null,
    modelChat: null,
    modelEmbedding: null,
  },
  ...over,
})

/** The mock gateway's decision endpoint behind a fetch stub: the same contract as OpenRouter's. */
function mockFetch(): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = mockDecision(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

function deps(over: Partial<LlmDecideDeps> = {}): LlmDecideDeps & { logged: unknown[] } {
  const logged: unknown[] = []
  return {
    logged,
    resolve: async () => target(),
    capCheck: async () => {},
    fetch: mockFetch(),
    logCall: async (userId, entry) => {
      logged.push({ userId, ...entry })
    },
    now: () => Date.now(),
    ...over,
  }
}

const questions = {
  mine: { instructions: 'Is this mail mine to act on?', criteria: { yes: 'It asks for finance work.', no: 'It does not.' } },
}

describe('decisionsUrl', () => {
  it('is the Decisions API next to the OpenAI-compatible /v1 (OpenRouter: /api/alpha/decisions)', () => {
    expect(decisionsUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/alpha/decisions')
    expect(decisionsUrl('http://127.0.0.1:5199/v1/')).toBe('http://127.0.0.1:5199/alpha/decisions')
  })

  it('fails loud on an endpoint that does not end in /v1 (no guessed path)', () => {
    expect(() => decisionsUrl('https://example.com/openai')).toThrow(LlmNotConfiguredError)
  })
})

describe('llmDecide', () => {
  it('asks several questions in one call, returns each answer, and logs one cost row on the acting user', async () => {
    const d = deps()
    const out = await llmDecide(
      {
        userId: 'user-7',
        state: 'Invoice #44 has the wrong VAT [mock-decide:urgency=high@0.8]',
        questions: { ...questions, urgency: { instructions: 'How urgent?', criteria: { low: 'No deadline', high: 'This week' } } },
        task: 'decisions.judge',
        kindId: 'coworkers.event_mine',
      },
      d,
    )
    expect(out.model).toBe('typesafe/jev-1.13-mock')
    expect(out.answers.mine).toEqual({ choice: 'yes', confidence: 1, distribution: { yes: 1, no: 0 } })
    expect(out.answers.urgency).toMatchObject({ choice: 'high', confidence: 0.8 })
    expect(out.costUsd).toBeCloseTo(0.000014)
    expect(d.fetch).toHaveBeenCalledTimes(1)
    const [url, init] = vi.mocked(d.fetch).mock.calls[0]!
    expect(url).toBe('https://inference.example/alpha/decisions')
    expect(JSON.parse(String(init?.body))).toMatchObject({
      model: 'typesafe/jev-1.13',
      questions: { mine: { type: 'choice', criteria: questions.mine.criteria } },
    })
    expect(d.logged).toEqual([
      expect.objectContaining({
        userId: 'user-7',
        provider: 'platform',
        gatewayHost: 'inference.example',
        baseCostUsd: 0.000014,
        operation: 'llm.decide.success(attempt=1,model=typesafe/jev-1.13)',
      }),
    ])
  })

  it('never logs the state (it may be a private mail) or the key: the cost row names the kind and the count only', async () => {
    const d = deps()
    await llmDecide({ userId: 'u', state: 'PRIVATE BODY', questions, task: 'decisions.judge', kindId: 'k.id' }, d)
    const row = JSON.stringify(d.logged)
    expect(row).not.toContain('PRIVATE BODY')
    expect(row).not.toContain('sk-secret-key')
    expect(row).toContain('decide:k.id questions=1')
  })

  it('fails loud when Jev answers outside the closed set (no repair, no remap) and logs the call', async () => {
    const d = deps()
    const err = await llmDecide({ userId: 'u', state: '[mock-decide:mine=perhaps@0.9]', questions, task: 'decisions.judge', kindId: 'k' }, d).catch((e) => e)
    expect(err).toBeInstanceOf(DecisionOutOfSetError)
    expect(err.message).toContain('perhaps')
    expect(d.fetch).toHaveBeenCalledTimes(1)
    expect(d.logged).toEqual([expect.objectContaining({ operation: expect.stringContaining('llm.decide.error') })])
  })

  it('fails loud without a decision model (a provider outside the pool namespace)', async () => {
    const d = deps({ resolve: async () => target({ model: null }) })
    await expect(llmDecide({ userId: 'u', state: 's', questions, task: 'decisions.judge', kindId: 'k' }, d)).rejects.toBeInstanceOf(LlmNotConfiguredError)
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('passes slot errors through (no key: LlmNotConfiguredError; a stored model outside the pool)', async () => {
    const none = deps({ resolve: async () => Promise.reject(new LlmNotConfiguredError('no key')) })
    await expect(llmDecide({ userId: 'u', state: 's', questions, task: 'decisions.judge', kindId: 'k' }, none)).rejects.toBeInstanceOf(LlmNotConfiguredError)
    const off = deps({ resolve: async () => Promise.reject(new ModelNotInPoolError('decision', 'x/y')) })
    await expect(llmDecide({ userId: 'u', state: 's', questions, task: 'decisions.judge', kindId: 'k' }, off)).rejects.toBeInstanceOf(ModelNotInPoolError)
  })

  it('refuses a question with fewer than two choices, and a call with no question, before any request', async () => {
    const d = deps()
    await expect(
      llmDecide({ userId: 'u', state: 's', questions: { q: { instructions: 'x', criteria: { only: 'o' } } }, task: 'decisions.judge', kindId: 'k' }, d),
    ).rejects.toThrow(/at least two choices/)
    await expect(llmDecide({ userId: 'u', state: 's', questions: {}, task: 'decisions.judge', kindId: 'k' }, d)).rejects.toThrow(/at least one question/)
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('checks the daily cap before the call', async () => {
    const d = deps({ capCheck: async () => Promise.reject(new Error('over the cap')) })
    await expect(llmDecide({ userId: 'u', state: 's', questions, task: 'decisions.judge', kindId: 'k' }, d)).rejects.toThrow('over the cap')
    expect(d.fetch).not.toHaveBeenCalled()
  })

  it('a refusal (4xx) is not retried; a 5xx is retried up to three attempts, each logged', async () => {
    const refused = deps({
      fetch: vi.fn(async () => new Response(JSON.stringify({ error: { message: 'bad question' } }), { status: 400 })) as unknown as typeof fetch,
    })
    const err = await llmDecide({ userId: 'u', state: 's', questions, task: 'decisions.judge', kindId: 'k' }, refused).catch((e) => e)
    expect(err).toBeInstanceOf(LlmHttpError)
    expect(err.status).toBe(400)
    expect(refused.fetch).toHaveBeenCalledTimes(1)

    const down = deps({
      fetch: vi.fn(async () => new Response('upstream', { status: 502 })) as unknown as typeof fetch,
    })
    await expect(llmDecide({ userId: 'u', state: 's', questions, task: 'decisions.judge', kindId: 'k' }, down)).rejects.toBeInstanceOf(LlmHttpError)
    expect(down.fetch).toHaveBeenCalledTimes(3)
    expect(down.logged).toHaveLength(3)
  })
})
