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
