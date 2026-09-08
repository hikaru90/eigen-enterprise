import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  testLlmProviderConnectionMock,
  saveProviderConfigMock,
  isByokUiEnabledMock,
  authDbMock,
} = vi.hoisted(() => ({
  testLlmProviderConnectionMock: vi.fn(),
  saveProviderConfigMock: vi.fn(),
  isByokUiEnabledMock: vi.fn(),
  authDbMock: {},
}))

vi.mock('$lib/server/llm/provider-test', () => ({
  testLlmProviderConnection: testLlmProviderConnectionMock,
}))
vi.mock('$lib/server/llm/save-provider-config', () => ({
  saveProviderConfig: saveProviderConfigMock,
}))
vi.mock('$lib/server/settings/byok-ui', () => ({ isByokUiEnabled: isByokUiEnabledMock }))
vi.mock('$lib/server/db/auth-db', () => ({ authDb: authDbMock }))

import { POST as POST_PROVIDER } from './provider/+server'
import { POST as POST_TEST } from './test-provider/+server'

function event(overrides?: Record<string, unknown>) {
  return {
    locals: { user: { id: 'u1', email: 'a@b.c' } },
    request: {
      json: async () => ({
        provider: 'openrouter',
        baseUrl: 'https://openrouter.example/api/v1',
        apiKey: 'key-1',
        modelChat: 'openai/gpt-4o-mini',
        modelEmbedding: 'openai/text-embedding-3-small',
        ...(overrides ?? {}),
      }),
    },
  } as never
}

function updateChain() {
  const chain: Record<string, unknown> = {}
  chain.update = () => chain
  chain.set = () => chain
  chain.where = () => Promise.resolve()
  return chain
}

describe('onboarding provider endpoints', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isByokUiEnabledMock.mockReturnValue(true)
    saveProviderConfigMock.mockResolvedValue(undefined)
    testLlmProviderConnectionMock.mockResolvedValue({ ok: true, model: 'm', latencyMs: 42 })
    authDbMock.update = vi.fn(() => updateChain())
  })

  describe('POST /api/onboarding/test-provider', () => {
    it('runs a dry-run test and returns the result without saving', async () => {
      const res = await POST_TEST(event())
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({ ok: true, model: 'm' })
      expect(saveProviderConfigMock).not.toHaveBeenCalled()
    })

    it('returns ok:false payloads as 200 (the test ran, the provider failed)', async () => {
      testLlmProviderConnectionMock.mockResolvedValue({ ok: false, error: 'HTTP 401: bad key' })
      const res = await POST_TEST(event())
      expect(res.status).toBe(200)
      await expect(res.json()).resolves.toMatchObject({ ok: false, error: expect.any(String) })
      expect(saveProviderConfigMock).not.toHaveBeenCalled()
    })

    it('rejects anonymous callers', async () => {
      const res = await POST_TEST({ locals: { user: null }, request: event().request } as never)
      expect(res.status).toBe(401)
    })

    it('rejects deployments with the BYOK UI disabled', async () => {
      isByokUiEnabledMock.mockReturnValue(false)
      const res = await POST_TEST(event())
      expect(res.status).toBe(403)
    })

    it('rejects an incomplete credential shape', async () => {
      const res = await POST_TEST(event({ apiKey: '' }))
      expect(res.status).toBe(400)
      const body = (await res.json()) as { error?: string }
      expect(body.error).toMatch(/API key/i)
      expect(testLlmProviderConnectionMock).not.toHaveBeenCalled()
    })
  })

  describe('POST /api/onboarding/provider', () => {
    it('saves via the shared service and marks onboarding complete', async () => {
      const res = await POST_PROVIDER(event())

      expect(res.status).toBe(200)
      expect(saveProviderConfigMock).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'u1',
          provider: 'openrouter',
          baseUrl: 'https://openrouter.example/api/v1',
          setActive: true,
        }),
      )
      expect(authDbMock.update).toHaveBeenCalled()
      await expect(res.json()).resolves.toMatchObject({ ok: true })
    })

    it('rejects anonymous callers', async () => {
      const res = await POST_PROVIDER({ locals: { user: null }, request: event().request } as never)
      expect(res.status).toBe(401)
    })

    it('rejects deployments with the BYOK UI disabled', async () => {
      isByokUiEnabledMock.mockReturnValue(false)
      const res = await POST_PROVIDER(event())
      expect(res.status).toBe(403)
    })

    it('maps validation failures to 400 with the service message', async () => {
      saveProviderConfigMock.mockRejectedValue(new Error('Base URL must start with http:// or https://'))
      const res = await POST_PROVIDER(event({ baseUrl: 'openrouter.example' }))
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toMatchObject({
        error: 'Base URL must start with http:// or https://',
      })
    })

    it('requires EUrouter routing rules — BYOK chat cannot work without them', async () => {
      const res = await POST_PROVIDER(
        event({
          provider: 'eurouter',
          baseUrl: 'https://gw.example.test/v1',
          ruleChat: '',
          ruleEmbedding: '',
        }),
      )
      expect(res.status).toBe(400)
      await expect(res.json()).resolves.toMatchObject({
        error: expect.stringMatching(/rule/i),
      })
      expect(saveProviderConfigMock).not.toHaveBeenCalled()
    })
  })
})
