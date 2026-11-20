import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDbMock, mockEnv, hasSavedByokLlmCredentialsMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  mockEnv: {} as Record<string, string | undefined>,
  hasSavedByokLlmCredentialsMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/env/private-env', () => ({ env: mockEnv }))
vi.mock('$lib/server/llm/preferences', () => ({
  hasSavedByokLlmCredentials: hasSavedByokLlmCredentialsMock,
}))

import { isUserProviderReady } from './provider-ready'

/** Sequential-limit select chain: nth .limit() resolves nth result set. */
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

describe('isUserProviderReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(mockEnv)) delete mockEnv[key]
    hasSavedByokLlmCredentialsMock.mockResolvedValue(false)
    mockSequentialDbLimitResults([])
  })

  it('own key: true when the account has saved credentials (no env needed)', async () => {
    mockSequentialDbLimitResults([])
    hasSavedByokLlmCredentialsMock.mockResolvedValue(true)
    await expect(isUserProviderReady('u1', 'byok')).resolves.toBe(true)
  })

  it('ignores saved credentials while the company is on eigenInference', async () => {
    hasSavedByokLlmCredentialsMock.mockResolvedValue(true)
    await expect(isUserProviderReady('u1', 'eigeninference')).resolves.toBe(false)
  })

  it('the removed self-hosted service accounts no longer make eigenInference ready (CB1)', async () => {
    mockEnv.LLM_BASE_URL = 'https://gw.example.test/v1'
    mockEnv.SERVICE_API_KEY_EUROUTER = 'service-key'
    mockEnv.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1'
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-key'
    mockSequentialDbLimitResults([{ provider: 'openrouter' }])
    await expect(isUserProviderReady('u1', 'eigeninference')).resolves.toBe(false)
  })

  it('is false on eigenInference without any gateway env', async () => {
    await expect(isUserProviderReady('u1', 'eigeninference')).resolves.toBe(false)
  })

  it('in byok billing without saved creds, falls back to the BYOK env pair', async () => {
    mockSequentialDbLimitResults([])
    mockEnv.LLM_BASE_URL = 'https://gw.example.test/v1'
    mockEnv.LLM_API_KEY = 'user-env-key'
    await expect(isUserProviderReady('u1', 'byok')).resolves.toBe(true)
  })

  it('own key without saved creds or env, is false even when the platform AI exists', async () => {
    mockSequentialDbLimitResults([])
    Object.assign(mockEnv, PLATFORM_AI)
    await expect(isUserProviderReady('u1', 'byok')).resolves.toBe(false)
  })

  it('never throws on an empty database', async () => {
    await expect(isUserProviderReady('u1', 'eigeninference')).resolves.toBe(false)
  })

  describe('platform AI from hosting (PLATFORM_LLM_*)', () => {
    function setPlatformAi() {
      Object.assign(mockEnv, PLATFORM_AI)
    }

    it('is true on platform credits with only the platform AI set (a hosted box: no service keys)', async () => {
      setPlatformAi()
      await expect(isUserProviderReady('u1', 'eigeninference')).resolves.toBe(true)
    })

    it('is true even when the active-provider row says openrouter (the platform AI is the platform path)', async () => {
      mockSequentialDbLimitResults([{ provider: 'openrouter' }])
      setPlatformAi()
      await expect(isUserProviderReady('u1', 'eigeninference')).resolves.toBe(true)
    })

    it('a user who chose BYOK still needs their own key: platform AI does not make them ready', async () => {
      mockSequentialDbLimitResults([])
      setPlatformAi()
      await expect(isUserProviderReady('u1', 'byok')).resolves.toBe(false)
    })

    it('a partial platform AI fails loud, naming what is missing', async () => {
      setPlatformAi()
      delete mockEnv.PLATFORM_LLM_API_KEY
      await expect(isUserProviderReady('u1', 'eigeninference')).rejects.toThrow(/PLATFORM_LLM_API_KEY is not set/)
    })
  })
})

const PLATFORM_AI = {
  PLATFORM_LLM_BASE_URL: 'https://llm.example.test/api/v1',
  PLATFORM_LLM_API_KEY: 'sk-platform',
  PLATFORM_LLM_MODEL_CHAT: 'vendor/chat-1',
  PLATFORM_LLM_MODEL_EMBEDDING: 'vendor/embed-1',
}

describe('isCompanyProviderReady', () => {
  it('asks about the company source (the Settings → AI switch) with the owner’s account, not the member’s own settings', async () => {
    const { isCompanyProviderReady } = await import('./provider-ready')
    const asked: string[] = []
    const ready = await isCompanyProviderReady({
      companyAccountId: async () => 'owner-1',
      companySource: async () => 'byok',
      withDbUser: async (userId, fn) => {
        asked.push(`db:${userId}`)
        return fn()
      },
      isUserProviderReady: async (userId, source) => {
        asked.push(`ready:${userId}:${source}`)
        return userId === 'owner-1'
      },
    })
    expect(ready).toBe(true)
    expect(asked).toEqual(['db:owner-1', 'ready:owner-1:byok'])
  })

  it('reads the company source inside the owner’s DB session (works outside a request, e.g. a background tick)', async () => {
    const { isCompanyProviderReady } = await import('./provider-ready')
    let inSession = false
    const ready = await isCompanyProviderReady({
      companyAccountId: async () => 'owner-1',
      companySource: async () => {
        if (!inSession) throw new Error('getDb() was called outside an active request (missing app DB context)')
        return 'byok'
      },
      withDbUser: async (_userId, fn) => {
        inSession = true
        try {
          return await fn()
        } finally {
          inSession = false
        }
      },
      isUserProviderReady: async () => true,
    })
    expect(ready).toBe(true)
  })

  it('a hosted box with the platform AI env is ready (the onboarding skips the provider step)', async () => {
    const { isCompanyProviderReady } = await import('./provider-ready')
    for (const key of Object.keys(mockEnv)) delete mockEnv[key]
    Object.assign(mockEnv, PLATFORM_AI)
    hasSavedByokLlmCredentialsMock.mockResolvedValue(false)
    mockSequentialDbLimitResults([])
    const ready = await isCompanyProviderReady({
      companyAccountId: async () => 'owner-1',
      companySource: async () => 'eigeninference',
      withDbUser: async (_userId, fn) => fn(),
      isUserProviderReady,
    })
    expect(ready).toBe(true)
    for (const key of Object.keys(mockEnv)) delete mockEnv[key]
  })

  it('is not ready when the company has no owner yet (no company provider exists)', async () => {
    const { isCompanyProviderReady } = await import('./provider-ready')
    const ready = await isCompanyProviderReady({
      companyAccountId: async () => null,
      companySource: async () => {
        throw new Error('must not read the company source')
      },
      withDbUser: async () => {
        throw new Error('must not read any account')
      },
      isUserProviderReady: async () => {
        throw new Error('must not check any account')
      },
    })
    expect(ready).toBe(false)
  })
})
