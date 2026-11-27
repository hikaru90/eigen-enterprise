import type { CompanyAiSettings, CompanyAiStore } from './company-ai'
import { describe, expect, it, vi } from 'vitest'
import {
  CompanyAiInputError,
  readCompanyAiView,
  setCompanySlotModel,
  setCompanyUseEigenInference,
} from './company-ai-settings'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: { DATABASE_URL: 'postgres://test@localhost:5433/test' } as Record<string, string>,
}))
vi.mock('$lib/server/env/private-env', () => ({ env: mockEnv }))

function memoryStore(initial: Partial<CompanyAiSettings> = {}): CompanyAiStore & { state: CompanyAiSettings } {
  const state: CompanyAiSettings = {
    useEigenInference: true,
    picks: { chat: null, stt: null, tts: null, decision: null },
    embeddingModel: null,
    ...initial,
  }
  return {
    state,
    read: async () => structuredClone(state),
    setUseEigenInference: async (on) => {
      state.useEigenInference = on
    },
    setPick: async (slot, model) => {
      state.picks[slot] = model
    },
    pinEmbeddingModel: async (model) => (state.embeddingModel ??= model),
  }
}

describe('Settings → AI service', () => {
  it('shows the switch, the four slots with the pool as options and the fixed embedding model', async () => {
    const view = await readCompanyAiView(memoryStore({ embeddingModel: 'qwen/qwen3-embedding-8b' }))
    expect(view.useEigenInference).toBe(true)
    expect(view.eigenInferenceAvailable).toBe(false)
    expect(view.slots.map((s) => s.slot)).toEqual(['chat', 'stt', 'tts', 'decision'])
    expect(view.slots.find((s) => s.slot === 'decision')).toMatchObject({ model: 'typesafe/jev-1.13', pick: null })
    expect(view.slots.find((s) => s.slot === 'chat')!.options.map((o) => o.id)).toContain('openai/gpt-5-mini')
    expect(view.embeddingModel).toBe('qwen/qwen3-embedding-8b')
    expect(view.provider).toBe('openrouter')
    expect(view.slots.every((s) => s.available)).toBe(true)
  })

  const OPPER = {
    PLATFORM_LLM_BASE_URL: 'https://api.opper.ai/v3/compat',
    PLATFORM_LLM_API_KEY: 'sk',
    PLATFORM_LLM_MODEL_CHAT: '~deepseek/deepseek-flash-latest',
    PLATFORM_LLM_MODEL_EMBEDDING: 'qwen/qwen3-embedding-8b',
    PLATFORM_LLM_PROVIDER: 'opper',
  }
  async function onOpper<T>(fn: () => Promise<T>): Promise<T> {
    Object.assign(mockEnv, OPPER)
    try {
      return await fn()
    } finally {
      for (const k of Object.keys(OPPER)) delete mockEnv[k]
    }
  }

  it("on Opper: only the models Opper serves are offered, Opper's picks where the company chose none", async () => {
    const view = await onOpper(() => readCompanyAiView(memoryStore()))
    expect(view.provider).toBe('opper')
    const slot = (name: string) => view.slots.find((s) => s.slot === name)!
    expect(slot('stt')).toMatchObject({ model: 'mistral/voxtral-mini-transcribe-3-0', pick: null, available: true })
    expect(slot('stt').options.map((o) => o.id)).toEqual(['mistral/voxtral-mini-transcribe-3-0'])
    expect(slot('tts').options.map((o) => o.id)).toEqual(['mistral/voxtral-mini-tts-3-0'])
    expect(slot('decision')).toMatchObject({ model: 'ovhcloud/clef-flash', options: [{ id: 'ovhcloud/clef-flash', recommended: true }] })
    expect(slot('chat').options.map((o) => o.id)).toContain('openai/gpt-5-mini')
  })

  it('on Opper: a stored pick Opper does not serve shows as unavailable (never shown as another model)', async () => {
    const store = memoryStore({ picks: { chat: null, stt: 'qwen/qwen3-asr-1.7b', tts: null, decision: null } })
    const view = await onOpper(() => readCompanyAiView(store))
    expect(view.slots.find((s) => s.slot === 'stt')).toMatchObject({ model: 'qwen/qwen3-asr-1.7b', pick: 'qwen/qwen3-asr-1.7b', available: false })
  })

  it('on Opper: picking a model Opper does not serve is refused, naming what it serves', async () => {
    const store = memoryStore()
    await onOpper(async () => {
      await expect(setCompanySlotModel('decision', 'typesafe/jev-1.13', 'o', store)).rejects.toBeInstanceOf(CompanyAiInputError)
      await expect(setCompanySlotModel('decision', 'typesafe/jev-1.13', 'o', store)).rejects.toThrow(/not available on Opper.*ovhcloud\/clef-flash/)
      await setCompanySlotModel('decision', 'ovhcloud/clef-flash', 'o', store)
    })
    expect(store.state.picks.decision).toBe('ovhcloud/clef-flash')
  })

  it("on its own key the company picks from OpenRouter's pool, whatever eigenInference runs on", async () => {
    const view = await onOpper(() => readCompanyAiView(memoryStore({ useEigenInference: false })))
    expect(view.provider).toBe('openrouter')
    expect(view.slots.find((s) => s.slot === 'decision')).toMatchObject({ model: 'typesafe/jev-1.13' })
  })

  it('eigenInference is available once the hosting set PLATFORM_LLM_*', async () => {
    Object.assign(mockEnv, {
      PLATFORM_LLM_BASE_URL: 'https://ai.example.test/api/v1',
      PLATFORM_LLM_API_KEY: 'sk',
      PLATFORM_LLM_MODEL_CHAT: 'openai/gpt-5-mini',
      PLATFORM_LLM_MODEL_EMBEDDING: 'qwen/qwen3-embedding-8b',
    })
    try {
      expect((await readCompanyAiView(memoryStore())).eigenInferenceAvailable).toBe(true)
    } finally {
      for (const k of Object.keys(mockEnv)) if (k.startsWith('PLATFORM_LLM_')) delete mockEnv[k]
    }
  })

  it('sets the switch and a slot to a pool model', async () => {
    const store = memoryStore()
    await setCompanyUseEigenInference(false, 'owner-1', store)
    await setCompanySlotModel('chat', 'openai/gpt-5-mini', 'owner-1', store)
    expect(store.state).toMatchObject({ useEigenInference: false, picks: { chat: 'openai/gpt-5-mini' } })
  })

  it('refuses a model outside the pool and the embedding slot, naming the choices', async () => {
    const store = memoryStore()
    await expect(setCompanySlotModel('chat', 'vendor/x', 'o', store)).rejects.toBeInstanceOf(CompanyAiInputError)
    await expect(setCompanySlotModel('chat', 'vendor/x', 'o', store)).rejects.toThrow(/Choose one of/)
    await expect(setCompanySlotModel('embedding', 'qwen/qwen3-embedding-8b', 'o', store)).rejects.toThrow(
      /fixed per install/,
    )
    expect(store.state.picks.chat).toBeNull()
  })
})
