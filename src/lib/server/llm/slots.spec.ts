import type { CompanyAiSettings } from './company-ai'
import type { ResolvedLlmConfig } from './types'
import { describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from './errors'
import { ModelNotInPoolError } from './model-pool'
import { companySlotSource, resolveSlot, type SlotDeps } from './slots'

vi.mock('$lib/server/env/private-env', () => ({ env: { DATABASE_URL: 'postgres://test@localhost:5433/test' } }))

function config(provider: string, over: Partial<ResolvedLlmConfig> = {}): ResolvedLlmConfig {
  return {
    provider,
    baseUrl: `https://${provider}.example/v1`,
    apiKey: `key-${provider}`,
    ruleChat: null,
    ruleEmbedding: null,
    modelChat: null,
    modelEmbedding: null,
    ...over,
  }
}

function settings(over: Partial<CompanyAiSettings> = {}): CompanyAiSettings {
  return {
    useEigenInference: true,
    picks: { chat: null, stt: null, tts: null, decision: null },
    embeddingModel: null,
    ...over,
  }
}

function deps(over: Partial<SlotDeps> = {}, company: CompanyAiSettings = settings()): SlotDeps {
  return {
    readCompanyAi: async () => company,
    pinEmbeddingModel: async (model) => model,
    eigenInference: async () => config('platform'),
    companyOwnerId: async () => 'owner-olga',
    byokActive: async () => config('openrouter'),
    byokProvider: async (_account, provider) => config(provider),
    harnessAccount: () => undefined,
    harnessUsesOwnKey: async () => false,
    ...over,
  }
}

describe('resolveSlot: one resolution for every model call, for the company', () => {
  it('eigenInference on: every slot goes to the hosting endpoint with the pool pick', async () => {
    const d = deps()
    for (const [slot, model] of [
      ['chat', '~deepseek/deepseek-flash-latest'],
      ['stt', 'qwen/qwen3-asr-1.7b'],
      ['tts', 'qwen/qwen-audio-3.0-tts-flash'],
      ['decision', 'typesafe/jev-1.13'],
      ['embedding', 'qwen/qwen3-embedding-8b'],
    ] as const) {
      const target = await resolveSlot(slot, 'member-ony', d)
      expect(target).toMatchObject({ slot, source: 'eigeninference', model })
      expect(target.config.provider).toBe('platform')
    }
  })

  it('eigenInference is one credential for every slot, whoever the owner is', async () => {
    const eigenInference = vi.fn(async () => config('platform'))
    const companyOwnerId = vi.fn(async () => 'owner-olga')
    const d = deps({ eigenInference, companyOwnerId })
    await resolveSlot('chat', 'u', d)
    await resolveSlot('decision', 'u', d)
    expect(eigenInference).toHaveBeenCalledTimes(2)
    expect(companyOwnerId).not.toHaveBeenCalled()
  })

  it("own key: the owner's provider, whoever triggered the call (a member's settings never count)", async () => {
    const byokActive = vi.fn(async () => config('openrouter'))
    const target = await resolveSlot('chat', 'member-ony', deps({ byokActive }, settings({ useEigenInference: false })))
    expect(target.source).toBe('byok')
    expect(byokActive).toHaveBeenCalledWith('owner-olga')
  })

  it("own key: speech and Jev run on the company's OpenRouter key even when chat uses another provider", async () => {
    const byokProvider = vi.fn(async (_a: string, p: string) => config(p))
    const d = deps({ byokActive: async () => config('eurouter', { ruleChat: 'r' }), byokProvider }, settings({ useEigenInference: false }))
    const stt = await resolveSlot('stt', 'u', d)
    expect(byokProvider).toHaveBeenCalledWith('owner-olga', 'openrouter')
    expect(stt.model).toBe('qwen/qwen3-asr-1.7b')
  })

  it('a provider outside the pool namespace (EUrouter rules) routes chat by its own rule: model null', async () => {
    const d = deps({ byokActive: async () => config('eurouter', { ruleChat: 'rule-1' }) }, settings({ useEigenInference: false }))
    await expect(resolveSlot('chat', 'u', d)).resolves.toMatchObject({ model: null, config: { provider: 'eurouter' } })
  })

  it('a pick that is in the pool is used', async () => {
    const d = deps({}, settings({ picks: { chat: 'openai/gpt-5-mini', stt: null, tts: null, decision: null } }))
    await expect(resolveSlot('chat', 'u', d)).resolves.toMatchObject({ model: 'openai/gpt-5-mini' })
  })

  it('a stored pick outside the pool fails loud (no silent substitute)', async () => {
    const d = deps({}, settings({ picks: { chat: 'vendor/unvetted', stt: null, tts: null, decision: null } }))
    await expect(resolveSlot('chat', 'u', d)).rejects.toBeInstanceOf(ModelNotInPoolError)
  })

  it('embedding: an install that already embeds with a pool model keeps it (pinned once)', async () => {
    const pin = vi.fn(async (m: string) => m)
    const d = deps(
      { eigenInference: async () => config('platform', { modelEmbedding: 'openai/text-embedding-3-small' }), pinEmbeddingModel: pin },
    )
    await expect(resolveSlot('embedding', 'u', d)).resolves.toMatchObject({ model: 'openai/text-embedding-3-small' })
    expect(pin).toHaveBeenCalledWith('openai/text-embedding-3-small')
  })

  it('embedding: once pinned, the pin wins and nothing is pinned again', async () => {
    const pin = vi.fn(async (m: string) => m)
    const d = deps(
      { eigenInference: async () => config('platform', { modelEmbedding: 'openai/text-embedding-3-small' }), pinEmbeddingModel: pin },
      settings({ embeddingModel: 'qwen/qwen3-embedding-8b' }),
    )
    await expect(resolveSlot('embedding', 'u', d)).resolves.toMatchObject({ model: 'qwen/qwen3-embedding-8b' })
    expect(pin).not.toHaveBeenCalled()
  })

  it('embedding: an install that embeds with a model outside the pool fails loud instead of re-embedding silently', async () => {
    const d = deps({ eigenInference: async () => config('platform', { modelEmbedding: 'vendor/embed-x' }) })
    await expect(resolveSlot('embedding', 'u', d)).rejects.toBeInstanceOf(ModelNotInPoolError)
  })

  it('own key without an owner fails loud', async () => {
    const d = deps({ companyOwnerId: async () => null }, settings({ useEigenInference: false }))
    await expect(resolveSlot('chat', 'u', d)).rejects.toBeInstanceOf(LlmNotConfiguredError)
  })

  it('eigenInference without a credential fails loud with its own error, never another path', async () => {
    const d = deps({
      eigenInference: async () => {
        throw new LlmNotConfiguredError('not connected')
      },
      byokActive: async () => {
        throw new Error('must not fall to the own-key path')
      },
    })
    await expect(resolveSlot('chat', 'u', d)).rejects.toThrow('not connected')
  })

  it("a benchmark/eval harness tenant runs on its operator's account and billing mode", async () => {
    const byokActive = vi.fn(async () => config('openrouter'))
    const d = deps({ harnessAccount: () => 'eval-runner-operator', harnessUsesOwnKey: async () => true, byokActive })
    expect(await companySlotSource('eval-corpus-x', d)).toBe('byok')
    await resolveSlot('chat', 'eval-corpus-x', d)
    expect(byokActive).toHaveBeenCalledWith('eval-runner-operator')
  })

  it('the decision slot (Jev) is stored and resolvable; nothing calls it before CB2', async () => {
    const d = deps({}, settings({ useEigenInference: false }))
    await expect(resolveSlot('decision', 'u', d)).resolves.toMatchObject({ model: 'typesafe/jev-1.13', source: 'byok' })
  })
})
