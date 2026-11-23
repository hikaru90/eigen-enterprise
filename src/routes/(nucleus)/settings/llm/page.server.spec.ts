import { beforeEach, describe, expect, it, vi } from 'vitest'

const { getDbMock, isUserAdminMock, decryptTenantValueMock, setSwitchMock, setSlotMock, checkSpeechMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  isUserAdminMock: vi.fn(),
  decryptTenantValueMock: vi.fn(),
  setSwitchMock: vi.fn(),
  setSlotMock: vi.fn(),
  checkSpeechMock: vi.fn(),
}))

vi.mock('$lib/server/llm/company-provider', () => ({ companyOwnerId: async () => 'owner-1' }))
vi.mock('$lib/server/llm/company-ai-settings', async (actual) => ({
  ...(await actual<typeof import('$lib/server/llm/company-ai-settings')>()),
  readCompanyAiView: async () => ({
    useEigenInference: false,
    eigenInferenceAvailable: false,
    embeddingModel: null,
    slots: [
      { slot: 'chat', model: '~deepseek/deepseek-flash-latest', pick: null, options: [] },
      { slot: 'stt', model: 'qwen/qwen3-asr-1.7b', pick: null, options: [] },
      { slot: 'tts', model: 'qwen/qwen-audio-3.0-tts-flash', pick: null, options: [] },
      { slot: 'decision', model: 'typesafe/jev-1.13', pick: null, options: [] },
    ],
  }),
  setCompanyUseEigenInference: setSwitchMock,
  setCompanySlotModel: setSlotMock,
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/settings/member-ai-cap-page', () => ({
  loadMemberAiCap: async () => ({
    usage: { role: 'member', capUsd: null, capApplies: false, spentUsd: 0, remainingUsd: null, resetsAt: '2026-11-24T00:00:00.000Z' },
  }),
  setMemberAiCapAction: vi.fn(),
}))
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
vi.mock('$lib/server/llm/speech-models', async (actual) => ({
  ...(await actual<typeof import('$lib/server/llm/speech-models')>()),
  checkSpeechModelEndpoints: checkSpeechMock,
}))

import { actions, load } from './+page.server'

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
    checkSpeechMock.mockResolvedValue([
      { feature: 'dictation', model: 'qwen/qwen3-asr-0.6b', endpoints: 2, providers: ['A', 'B'] },
    ])
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

  it('carries the company AI settings and checks the speech models the company picked', async () => {
    const result = await load({
      locals: { user: { id: 'owner-1', email: 'o@b.c' } },
      url: new URL('http://localhost/settings/llm'),
    } as never)
    expect(result.isOwner).toBe(true)
    expect(result.canManageAi).toBe(false)
    expect(result.ai.slots.map((s: { slot: string }) => s.slot)).toEqual(['chat', 'stt', 'tts', 'decision'])
    expect(checkSpeechMock).toHaveBeenCalledWith({
      models: [
        { feature: 'dictation', model: 'qwen/qwen3-asr-1.7b' },
        { feature: 'voice', model: 'qwen/qwen-audio-3.0-tts-flash' },
      ],
    })
  })
})

function post(fields: Record<string, string>, userId = 'u1') {
  const body = new FormData()
  for (const [k, v] of Object.entries(fields)) body.set(k, v)
  return {
    locals: { user: { id: userId, email: 'a@b.c' } },
    request: new Request('http://localhost/settings/llm', { method: 'POST', body }),
  } as never
}

describe('settings/llm actions: the switch and the slots (owners and admins only)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('a member cannot switch eigenInference or pick a model', async () => {
    isUserAdminMock.mockResolvedValue(false)
    await expect(actions.setEigenInference!(post({ on: 'true' }))).resolves.toMatchObject({ status: 403 })
    await expect(actions.setSlot!(post({ slot: 'chat', model: 'openai/gpt-5-mini' }))).resolves.toMatchObject({ status: 403 })
    expect(setSwitchMock).not.toHaveBeenCalled()
    expect(setSlotMock).not.toHaveBeenCalled()
  })

  it('an admin switches eigenInference off and picks a pool model', async () => {
    isUserAdminMock.mockResolvedValue(true)
    await actions.setEigenInference!(post({ on: 'false' }))
    expect(setSwitchMock).toHaveBeenCalledWith(false, 'u1')
    await actions.setSlot!(post({ slot: 'chat', model: 'openai/gpt-5-mini' }))
    expect(setSlotMock).toHaveBeenCalledWith('chat', 'openai/gpt-5-mini', 'u1')
  })

  it('a model outside the pool is a 400 with the reason, nothing saved', async () => {
    isUserAdminMock.mockResolvedValue(true)
    const { CompanyAiInputError } = await import('$lib/server/llm/company-ai-settings')
    setSlotMock.mockRejectedValueOnce(new CompanyAiInputError('"vendor/x" is not in the model pool'))
    await expect(actions.setSlot!(post({ slot: 'chat', model: 'vendor/x' }))).resolves.toMatchObject({
      status: 400,
      data: { slotMessage: '"vendor/x" is not in the model pool' },
    })
  })
})
