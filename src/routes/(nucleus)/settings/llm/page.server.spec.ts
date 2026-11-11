import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDbMock, isUserAdminMock, decryptTenantValueMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  isUserAdminMock: vi.fn(),
  decryptTenantValueMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isUserAdminMock }))
vi.mock('$lib/server/llm/preferences', () => ({
  assertByokConfigured: vi.fn(),
  hasSavedByokLlmCredentials: vi.fn(),
}))
vi.mock('$lib/server/crypto/tenant-encryption', () => ({
  decryptTenantValue: decryptTenantValueMock,
  encryptTenantValue: vi.fn(),
}))
vi.mock('$lib/server/env/private-env', () => ({
  env: {
    LLM_MODEL_CHAT: '',
    LLM_MODEL_EMBEDDING: '',
  },
}))

vi.mock('$lib/server/llm/speech-readiness', () => ({
  speechToTextReadiness: vi.fn(async () => ({ ready: false, missing: 'openrouter_key' })),
}))
vi.mock('$lib/server/llm/speech-models', () => ({
  checkSpeechModelEndpoints: vi.fn(async () => [
    { feature: 'dictation', model: 'qwen/qwen3-asr-0.6b', endpoints: 2, providers: ['A', 'B'] },
  ]),
}))

import { load } from './+page.server'

function makeSelectChain(rows: unknown[]) {
  const chain: {
    from: ReturnType<typeof vi.fn>
    where: ReturnType<typeof vi.fn>
    limit: ReturnType<typeof vi.fn>
    then: (onFulfilled: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) => Promise<unknown>
  } = {
    from: vi.fn(),
    where: vi.fn(),
    limit: vi.fn(async () => rows),
    then: (onFulfilled, onRejected) => Promise.resolve(rows).then(onFulfilled, onRejected),
  }
  chain.from.mockReturnValue(chain)
  chain.where.mockReturnValue(chain)
  return chain
}

describe('settings/llm page server load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isUserAdminMock.mockResolvedValue(false)
    getDbMock.mockReturnValue({
      select: vi.fn(() => makeSelectChain([])),
    })
  })

  it('redirects unauthenticated users to login', async () => {
    await expect(
      load({
        locals: { user: null },
        url: new URL('http://localhost/settings/llm'),
      } as never),
    ).rejects.toMatchObject({ status: 302, location: '/login' })
  })

  it('returns empty LLM settings shape without throwing when authenticated', async () => {
    const result = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/settings/llm'),
    } as never)

    expect(result.isAdmin).toBe(false)
    expect(result.byokConfigured).toBe(false)
    expect(result.activeProvider).toBe('eurouter')
    expect(result.providers.eurouter.configured).toBe(false)
    expect(result.providers.openrouter.configured).toBe(false)
    expect(result.providers.eurouter.apiKey).toBe('')
    expect(result.providers.openrouter.apiKey).toBe('')
  })

  it('carries the speech status: dictation readiness and each speech model’s endpoints', async () => {
    const result = await load({
      locals: { user: { id: 'u1', email: 'a@b.c' } },
      url: new URL('http://localhost/settings/llm'),
    } as never)
    expect(result.speech).toEqual({
      dictation: { ready: false, missing: 'openrouter_key' },
      models: [{ feature: 'dictation', model: 'qwen/qwen3-asr-0.6b', endpoints: 2, providers: ['A', 'B'] }],
    })
  })
})
