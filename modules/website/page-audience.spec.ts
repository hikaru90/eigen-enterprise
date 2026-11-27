import { describe, expect, it, vi } from 'vitest'
import { KernelError } from '$lib/kernel/errors'
import { decide } from '$lib/server/decisions/decide'
import { inMemoryDecisionStore } from '$lib/server/decisions/store'
import { LlmHttpError, LlmNotConfiguredError } from '$lib/server/llm/errors'
import { websitePageAudience } from './decision-kinds'
import {
  AUDIENCE_JSON_SCHEMA,
  AUDIENCE_MAX_ATTEMPTS,
  buildAudienceMessages,
  createPageAudienceClassifier,
  liveAudienceChat,
  NO_PROVIDER_MESSAGE,
  parseAudienceOutput,
  shadowedAudienceClassifier,
  type AudienceChat,
  type PageDraft,
} from './page-audience'

/**
 * Is this public website content or an internal document? (Contribute: pitch
 * decks, project descriptions and funding documents must never become website
 * pages.) The model judges — one gateway call with a JSON schema; code only
 * validates the answer (AGENTS.md: no string heuristics for meaning).
 */

const answer = (json: unknown) => ({ choices: [{ message: { content: typeof json === 'string' ? json : JSON.stringify(json) } }] })

const pitchDeck: PageDraft = {
  slug: 'pitch-deck',
  title: 'Seed pitch deck',
  body: '# Seed round\n\nWe raise €1.5M at a €8M pre-money valuation. Burn: €40k/month.',
  kind: 'doc',
  visibility: 'private',
}

describe('buildAudienceMessages', () => {
  it('states the rule, the JSON schema, and the page as data', () => {
    const [system, user] = buildAudienceMessages(pitchDeck)
    expect(system).toMatchObject({ role: 'system' })
    expect(system!.content).toContain(JSON.stringify(AUDIENCE_JSON_SCHEMA))
    expect(system!.content).toMatch(/public website/i)
    expect(system!.content).toMatch(/internal document/i)
    // The routing the refusal names is part of the judge's framing too.
    expect(system!.content).toMatch(/Drive/)
    expect(system!.content).toMatch(/Memory › Documents/)
    expect(user).toMatchObject({ role: 'user' })
    const page = JSON.parse(String(user!.content).slice(String(user!.content).indexOf('{')))
    expect(page).toEqual({
      slug: 'pitch-deck',
      title: 'Seed pitch deck',
      kind: 'doc',
      visibility: 'private',
      body: pitchDeck.body,
    })
  })

  it('bounds the prompt: a very long body is cut and says so', () => {
    const long = { ...pitchDeck, body: 'x'.repeat(50_000) }
    const [, user] = buildAudienceMessages(long)
    expect(String(user!.content).length).toBeLessThan(20_000)
    expect(String(user!.content)).toContain('truncated')
  })
})

describe('parseAudienceOutput', () => {
  it('accepts exactly the schema', () => {
    expect(parseAudienceOutput(answer({ audience: 'internal_document', reason: 'Investor terms and burn rate.' }))).toEqual({
      audience: 'internal_document',
      reason: 'Investor terms and burn rate.',
    })
    expect(parseAudienceOutput(answer('```json\n{"audience":"public_website","reason":"A product page."}\n```'))).toEqual({
      audience: 'public_website',
      reason: 'A product page.',
    })
  })

  it('throws on anything else (no guessed verdict)', () => {
    expect(() => parseAudienceOutput(answer('Hello from mock gateway.'))).toThrow()
    expect(() => parseAudienceOutput(answer({ audience: 'maybe', reason: 'x' }))).toThrow(/schema/)
    expect(() => parseAudienceOutput(answer({ audience: 'public_website' }))).toThrow(/schema/)
    expect(() => parseAudienceOutput(answer({ audience: 'public_website', reason: 'x', extra: 1 }))).toThrow(/schema/)
  })
})

describe('createPageAudienceClassifier', () => {
  it('asks the gateway once, in JSON mode at temperature 0, attributed to the caller', async () => {
    const chat = vi.fn<AudienceChat>().mockResolvedValue(answer({ audience: 'internal_document', reason: 'Fundraising terms.' }))
    const classify = createPageAudienceClassifier({ chat })
    await expect(classify({ userId: 'u1', page: pitchDeck })).resolves.toEqual({
      audience: 'internal_document',
      reason: 'Fundraising terms.',
    })
    expect(chat).toHaveBeenCalledTimes(1)
    expect(chat).toHaveBeenCalledWith({
      userId: 'u1',
      messages: buildAudienceMessages(pitchDeck),
      temperature: 0,
      task: 'website.page_audience',
      responseFormat: 'json_object',
    })
  })

  it(`retries an unreadable answer, then fails loud after ${AUDIENCE_MAX_ATTEMPTS} tries`, async () => {
    const chat = vi
      .fn<AudienceChat>()
      .mockResolvedValueOnce(answer('not json'))
      .mockResolvedValueOnce(answer({ audience: 'public_website', reason: 'Landing page copy.' }))
    await expect(createPageAudienceClassifier({ chat })({ userId: 'u1', page: pitchDeck })).resolves.toMatchObject({
      audience: 'public_website',
    })

    const broken = vi.fn<AudienceChat>().mockResolvedValue(answer('not json'))
    await expect(createPageAudienceClassifier({ chat: broken })({ userId: 'u1', page: pitchDeck })).rejects.toThrow(
      /could not be read/,
    )
    expect(broken).toHaveBeenCalledTimes(AUDIENCE_MAX_ATTEMPTS)
  })

  it('no AI provider or a refusal is not retried and creates nothing: a plain error', async () => {
    const none = vi.fn<AudienceChat>().mockRejectedValue(new LlmNotConfiguredError('no provider'))
    const err = await createPageAudienceClassifier({ chat: none })({ userId: 'u1', page: pitchDeck }).catch((e) => e)
    expect(err).toBeInstanceOf(KernelError)
    expect(err).toMatchObject({ code: 'not_configured' })
    expect(none).toHaveBeenCalledTimes(1)

    const refused = vi.fn<AudienceChat>().mockRejectedValue(new LlmHttpError(429, 'slow down'))
    await expect(createPageAudienceClassifier({ chat: refused })({ userId: 'u1', page: pitchDeck })).rejects.toThrow(
      /HTTP 429/,
    )
    expect(refused).toHaveBeenCalledTimes(1)
  })
})

describe('liveAudienceChat', () => {
  it('goes through the LLM gateway on the company provider (never a direct provider call)', async () => {
    const llmChatCompletion = vi.fn().mockResolvedValue(answer({ audience: 'public_website', reason: 'ok' }))
    const onCompanyProvider = vi.fn(<T,>(fn: () => Promise<T>) => fn())
    vi.doMock('$lib/server/llm/llm-client', () => ({ llmChatCompletion }))
    vi.doMock('$lib/server/llm/company-provider', () => ({ onCompanyProvider }))
    try {
      const input = {
        userId: 'u1',
        messages: buildAudienceMessages(pitchDeck),
        temperature: 0,
        task: 'website.page_audience',
        responseFormat: 'json_object' as const,
      }
      await expect(liveAudienceChat(input)).resolves.toEqual(answer({ audience: 'public_website', reason: 'ok' }))
      expect(onCompanyProvider).toHaveBeenCalledTimes(1)
      expect(llmChatCompletion).toHaveBeenCalledWith(input)
    } finally {
      vi.doUnmock('$lib/server/llm/llm-client')
      vi.doUnmock('$lib/server/llm/company-provider')
    }
  })
})

describe('shadowedAudienceClassifier (CB2: website.page_audience in shadow)', () => {
  const jev = (choice: 'public_website' | 'internal_document', confidence: number) =>
    vi.fn(async () => ({
      model: 'typesafe/jev-1.13-20260917',
      answers: { decision: { choice, confidence, distribution: { public_website: 1 - confidence, internal_document: confidence } } },
      costUsd: 0.000014,
      durationMs: 300,
    }))

  it('the guard acts on the chat judge’s verdict (reason included); Jev’s answer is logged next to it', async () => {
    const store = inMemoryDecisionStore()
    const judge = vi.fn(async () => ({ audience: 'internal_document' as const, reason: 'Investor terms.' }))
    const ask = jev('public_website', 0.8)
    const classify = shadowedAudienceClassifier(judge, (kind, input, opts) => decide(kind, input, opts, { ask, store }))
    await expect(classify({ userId: 'u1', page: pitchDeck })).resolves.toEqual({ audience: 'internal_document', reason: 'Investor terms.' })
    expect(judge).toHaveBeenCalledWith({ userId: 'u1', page: pitchDeck })
    expect(ask).toHaveBeenCalledWith(
      expect.objectContaining({ userId: 'u1', task: 'decisions.judge', kindId: 'website.page_audience', state: websitePageAudience.state(pitchDeck) }),
    )
    expect(store.rows()[0]).toMatchObject({
      kind: 'website.page_audience',
      status: 'shadow',
      judgeChoice: 'internal_document',
      jevChoice: 'public_website',
      usedSource: 'current_judge',
      requestedBy: 'u1',
      input: { slug: 'pitch-deck', title: 'Seed pitch deck', kind: 'doc', visibility: 'private', bodyChars: pitchDeck.body.length },
    })
    // The page body (an internal document) is never kept in the log.
    expect(JSON.stringify(store.rows())).not.toContain('pre-money')
  })

  it('a Jev failure leaves the guard exactly as today (the chat judge’s verdict)', async () => {
    const store = inMemoryDecisionStore()
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const classify = shadowedAudienceClassifier(
      async () => ({ audience: 'public_website' as const, reason: 'A product page.' }),
      (kind, input, opts) =>
        decide(kind, input, opts, { ask: vi.fn(async () => Promise.reject(new LlmNotConfiguredError('no decision slot'))), store }),
    )
    await expect(classify({ userId: 'u1', page: pitchDeck })).resolves.toEqual({ audience: 'public_website', reason: 'A product page.' })
    expect(store.rows()[0]).toMatchObject({ jevError: expect.stringContaining('no decision slot'), usedSource: 'current_judge' })
    error.mockRestore()
  })

  it('a chat judge failure stays the guard’s failure', async () => {
    const store = inMemoryDecisionStore()
    const classify = shadowedAudienceClassifier(
      async () => Promise.reject(new KernelError('not_configured', NO_PROVIDER_MESSAGE)),
      (kind, input, opts) => decide(kind, input, opts, { ask: jev('public_website', 1), store }),
    )
    await expect(classify({ userId: 'u1', page: pitchDeck })).rejects.toMatchObject({ code: 'not_configured' })
  })
})
