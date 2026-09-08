import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockEnv } = vi.hoisted(() => ({
  mockEnv: {} as Record<string, string | undefined>,
}))

vi.mock('$lib/server/env/private-env', () => ({ env: mockEnv }))

import { getProviderCatalog, resetCatalogCache } from './catalog'

const FIXTURE = {
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    npm: '@ai-sdk/openai',
    api: 'https://api.openai.com/v1',
    doc: 'https://docs.openai.com',
    models: {
      'gpt-4o-mini': {
        id: 'gpt-4o-mini',
        name: 'GPT-4o mini',
        modalities: { input: ['text'], output: ['text'] },
      },
      'text-embedding-3-small': {
        id: 'text-embedding-3-small',
        name: 'text-embedding-3-small',
        modalities: { input: ['text'], output: ['embedding'] },
      },
    },
  },
  groq: {
    id: 'groq',
    name: 'Groq',
    env: ['GROQ_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    api: 'https://api.groq.com/openai/v1',
    doc: 'https://groqdocs.test',
    models: {
      'llama-3.3-70b': {
        id: 'llama-3.3-70b',
        name: 'Llama 3.3 70B',
        modalities: { input: ['text'], output: ['text'] },
      },
    },
  },
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    api: 'https://api.anthropic.com/v1',
    models: {
      'claude-4': { id: 'claude-4', name: 'Claude 4', modalities: { input: ['text'], output: ['text'] } },
    },
  },
  eurouter: {
    id: 'eurouter',
    name: 'EUrouter (catalog mirror)',
    npm: '@ai-sdk/openai-compatible',
    api: 'https://mirror.example/v1',
    models: {},
  },
}

function jsonResponse(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as unknown as Response
}

describe('getProviderCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockEnv.MODELS_DEV_CATALOG_URL = ''
    resetCatalogCache()
  })

  afterEach(() => {
    vi.restoreAllMocks()
    resetCatalogCache()
  })

  it('maps openai-compatible providers and splits chat vs embedding models', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(FIXTURE)))

    const { providers } = await getProviderCatalog()

    // anthropic uses a different API shape — never offered via the API-key wizard.
    expect(providers.map((p) => p.id)).toContain('groq')
    expect(providers.map((p) => p.id)).not.toContain('anthropic')

    const groq = providers.find((p) => p.id === 'groq')!
    expect(groq.name).toBe('Groq')
    expect(groq.baseUrl).toBe('https://api.groq.com/openai/v1')
    expect(groq.envVar).toBe('GROQ_API_KEY')
    expect(groq.chatModels).toEqual([{ id: 'llama-3.3-70b', name: 'Llama 3.3 70B' }])
    expect(groq.embeddingModels).toEqual([])

    const openai = providers.find((p) => p.id === 'openai')!
    expect(openai.embeddingModels).toEqual([
      { id: 'text-embedding-3-small', name: 'text-embedding-3-small' },
    ])
  })

  it('pins EUrouter first-class at the top with routing-rule semantics', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(FIXTURE)))

    const { providers } = await getProviderCatalog()

    expect(providers[0]?.id).toBe('eurouter')
    expect(providers[0]?.baseUrl).toBe('https://api.eurouter.ai/v1')
    expect(providers[0]?.envVar).toBe('SERVICE_API_KEY_EUROUTER')
  })

  it('serves from cache without refetching within the cache window', async () => {
    const fetchMock = vi.fn(async () => jsonResponse(FIXTURE))
    vi.stubGlobal('fetch', fetchMock)

    await getProviderCatalog()
    await getProviderCatalog()

    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('honours MODELS_DEV_CATALOG_URL (e2e override)', async () => {
    mockEnv.MODELS_DEV_CATALOG_URL = 'http://127.0.0.1:5199/models.dev.json'
    const fetchMock = vi.fn(async () => jsonResponse(FIXTURE))
    vi.stubGlobal('fetch', fetchMock)

    await getProviderCatalog()

    expect(String(fetchMock.mock.calls[0]![0])).toBe('http://127.0.0.1:5199/models.dev.json')
  })

  it('fails loud when the catalog is unreachable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('getaddrinfo ENOTFOUND models.dev')
      }),
    )

    await expect(getProviderCatalog()).rejects.toThrow(/catalog/i)
  })
})
