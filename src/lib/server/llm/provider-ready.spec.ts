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
    mockSequentialDbLimitResults([], [])
  })

  it('is true when the user has saved BYOK credentials on byok billing (no env needed)', async () => {
    mockSequentialDbLimitResults([{ billingMode: 'byok' }], [])
    hasSavedByokLlmCredentialsMock.mockResolvedValue(true)
    await expect(isUserProviderReady('u1')).resolves.toBe(true)
  })

  it('ignores saved BYOK credentials while billing is platform_credits (platform path wins)', async () => {
    hasSavedByokLlmCredentialsMock.mockResolvedValue(true)
    await expect(isUserProviderReady('u1')).resolves.toBe(false)
  })

  it('is true on platform credits with the EUrouter service account configured', async () => {
    mockEnv.LLM_BASE_URL = 'https://gw.example.test/v1'
    mockEnv.SERVICE_API_KEY_EUROUTER = 'service-key'
    await expect(isUserProviderReady('u1')).resolves.toBe(true)
  })

  it('is false on platform credits without any gateway env', async () => {
    await expect(isUserProviderReady('u1')).resolves.toBe(false)
  })

  it('checks the OpenRouter service account when the active provider is openrouter', async () => {
    mockSequentialDbLimitResults([], [{ provider: 'openrouter' }])
    mockEnv.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1'
    mockEnv.SERVICE_API_KEY_OPENROUTER = 'service-key'
    await expect(isUserProviderReady('u1')).resolves.toBe(true)
  })

  it('is false when the openrouter active provider lacks its service key', async () => {
    mockSequentialDbLimitResults([], [{ provider: 'openrouter' }])
    mockEnv.OPENROUTER_BASE_URL = 'https://openrouter.example/api/v1'
    await expect(isUserProviderReady('u1')).resolves.toBe(false)
  })

  it('in byok billing without saved creds, falls back to the BYOK env pair', async () => {
    mockSequentialDbLimitResults([{ billingMode: 'byok' }], [])
    mockEnv.LLM_BASE_URL = 'https://gw.example.test/v1'
    mockEnv.LLM_API_KEY = 'user-env-key'
    await expect(isUserProviderReady('u1')).resolves.toBe(true)
  })

  it('in byok billing without saved creds or env, is false even when platform keys exist', async () => {
    mockSequentialDbLimitResults([{ billingMode: 'byok' }], [])
    mockEnv.LLM_BASE_URL = 'https://gw.example.test/v1'
    mockEnv.SERVICE_API_KEY_EUROUTER = 'service-key'
    await expect(isUserProviderReady('u1')).resolves.toBe(false)
  })

  it('never throws on an empty database', async () => {
    await expect(isUserProviderReady('u1')).resolves.toBe(false)
  })
})
