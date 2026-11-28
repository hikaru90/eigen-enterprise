import { beforeEach, describe, expect, it, vi } from 'vitest'

const m = vi.hoisted(() => ({
  ownerId: vi.fn(async (): Promise<string | null> => 'owner-1'),
  selectQueue: [] as unknown[][],
  updateReturning: vi.fn(async (): Promise<unknown[]> => []),
  updateSet: vi.fn(),
  setActive: vi.fn(async () => undefined),
  saveName: vi.fn(async (): Promise<{ ok: true; name: string } | { ok: false; error: string }> => ({
    ok: true,
    name: 'x',
  })),
  byokUi: vi.fn(() => true),
  withDbUserIds: [] as string[],
  eigenInference: false,
}))

vi.mock('$lib/server/db', () => {
  const db = {
    select: () => {
      const rows = m.selectQueue.shift() ?? []
      const node = {
        from: () => node,
        where: () => node,
        limit: () => Promise.resolve(rows),
        then: (resolve: (r: unknown[]) => unknown) => Promise.resolve(rows).then(resolve),
      }
      return node
    },
    update: () => ({
      set: (set: unknown) => {
        m.updateSet(set)
        return { where: () => ({ returning: m.updateReturning }) }
      },
    }),
  }
  return {
    withDbUser: async (id: string, fn: (d: unknown) => Promise<unknown>) => {
      m.withDbUserIds.push(id)
      return fn(db)
    },
  }
})
vi.mock('$lib/server/llm/company-provider', () => ({
  companyOwnerId: m.ownerId,
  onCompanyProvider: async (fn: () => Promise<unknown>) => fn(),
}))
vi.mock('$lib/server/llm/llm-client', () => ({ describeChatModel: vi.fn() }))
vi.mock('$lib/server/llm/company-ai-settings', async (actual) => ({
  ...(await actual<typeof import('$lib/server/llm/company-ai-settings')>()),
  readCompanyAiView: async () => ({
    useEigenInference: m.eigenInference,
    provider: 'openrouter',
    providerLabel: 'OpenRouter',
    eigenInferenceAvailable: false,
    slots: [
      { slot: 'chat', model: '~deepseek/deepseek-flash-latest', pick: null, available: true, options: [{ id: '~deepseek/deepseek-flash-latest', note: 'n', recommended: true }, { id: 'openai/gpt-5-mini', note: 'n', recommended: false }] },
      { slot: 'stt', model: 'qwen/qwen3-asr-1.7b', pick: null, available: true, options: [{ id: 'qwen/qwen3-asr-1.7b', note: 'n', recommended: true }] },
      { slot: 'tts', model: 'qwen/qwen-audio-3.0-tts-flash', pick: null, available: true, options: [{ id: 'qwen/qwen-audio-3.0-tts-flash', note: 'n', recommended: true }] },
      { slot: 'decision', model: 'typesafe/jev-1.13', pick: null, available: true, options: [{ id: 'typesafe/jev-1.13', note: 'n', recommended: true }] },
    ],
    embeddingModel: 'qwen/qwen3-embedding-8b',
  }),
}))
vi.mock('$lib/server/llm/active-provider', () => ({ setActiveLlmProvider: m.setActive }))
vi.mock('$lib/server/overview/sources', () => ({
  companyIdentity: async () => ({ name: 'Kindred', logo: null }),
}))
vi.mock('$lib/server/company/service', () => ({ saveCompanyName: m.saveName }))
vi.mock('$lib/server/company/store', () => ({ companyProfileStore: () => ({}) }))
vi.mock('$lib/server/profile/service', () => ({ getProfile: vi.fn() }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: vi.fn() }))
vi.mock('$lib/server/settings/byok-ui', () => ({ isByokUiEnabled: m.byokUi }))

import { agentSettingsPort } from './agent-settings'

beforeEach(() => {
  m.selectQueue.length = 0
  m.withDbUserIds.length = 0
  m.updateReturning.mockReset().mockResolvedValue([])
  m.updateSet.mockReset()
  m.setActive.mockClear()
  m.saveName.mockReset().mockResolvedValue({ ok: true, name: 'x' })
  m.ownerId.mockReset().mockResolvedValue('owner-1')
  m.byokUi.mockReset().mockReturnValue(true)
  m.eigenInference = false
})

describe('on eigenInference no model or provider is named (wish 60bd7be2)', () => {
  it('settings.get: no provider, no slots, no embedding model', async () => {
    m.eigenInference = true
    m.selectQueue.push([{ provider: 'openrouter' }], [])
    const view = await agentSettingsPort.read()
    expect(view.ai).toMatchObject({ eigenInference: true, modelProvider: 'openrouter', providerLabel: 'eigenInference', slots: [], embeddingModel: null, billing: 'platform' })
    expect(JSON.stringify(view)).not.toMatch(/deepseek|qwen|jev/)
  })

  it('whoami: the model is eigenInference', async () => {
    const { describeChatModel } = await import('$lib/server/llm/llm-client')
    vi.mocked(describeChatModel).mockResolvedValue({ provider: 'platform', model: 'mistral/deepseek-v4-1-flash-1017', routingRuleId: null, billing: 'platform', gatewayHost: 'api.opper.ai' })
    await expect(agentSettingsPort.modelFor('u1')).resolves.toEqual({ provider: 'eigenInference', model: 'eigenInference', routingRuleId: null, billing: 'platform', gatewayHost: 'eigenInference' })
  })
})

describe('agentSettingsPort.read', () => {
  it('reads the owner’s AI settings and never carries a credential', async () => {
    m.selectQueue.push(
      [{ provider: 'openrouter' }],
      [
        {
          provider: 'openrouter',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-or-SECRET',
          apiKeyEncrypted: 'enc-SECRET',
          authType: 'api_key',
          oauthAccessEncrypted: null,
          oauthRefreshEncrypted: null,
          modelChat: 'anthropic/claude-x',
          modelEmbedding: '',
          ruleChat: null,
          ruleEmbedding: null,
        },
      ],
    )
    const view = await agentSettingsPort.read()
    expect(m.withDbUserIds).toEqual(['owner-1'])
    expect(view).toEqual({
      company: { name: 'Kindred', hasLogo: false },
      ai: {
        eigenInference: false,
        modelProvider: 'openrouter',
        providerLabel: 'openrouter',
        slots: [
          { slot: 'chat', model: '~deepseek/deepseek-flash-latest', pick: null, available: true, options: ['~deepseek/deepseek-flash-latest', 'openai/gpt-5-mini'] },
          { slot: 'stt', model: 'qwen/qwen3-asr-1.7b', pick: null, available: true, options: ['qwen/qwen3-asr-1.7b'] },
          { slot: 'tts', model: 'qwen/qwen-audio-3.0-tts-flash', pick: null, available: true, options: ['qwen/qwen-audio-3.0-tts-flash'] },
          { slot: 'decision', model: 'typesafe/jev-1.13', pick: null, available: true, options: ['typesafe/jev-1.13'] },
        ],
        embeddingModel: 'qwen/qwen3-embedding-8b',
        activeProvider: 'openrouter',
        billing: 'byok',
        providers: [
          {
            provider: 'openrouter',
            configured: true,
            authType: 'api_key',
            modelChat: 'anthropic/claude-x',
            modelEmbedding: null,
            ruleChat: null,
            ruleEmbedding: null,
          },
        ],
      },
    })
    expect(JSON.stringify(view)).not.toContain('SECRET')
  })

  it('no owner yet: fails loud, reads nothing', async () => {
    m.ownerId.mockResolvedValue(null)
    await expect(agentSettingsPort.read()).rejects.toMatchObject({ code: 'not_configured' })
  })
})

describe('agentSettingsPort.apply', () => {
  it('company_name saves as the acting person; a refused name is invalid input', async () => {
    await agentSettingsPort.apply({ setting: 'company_name', value: 'Kindred Labs' }, 'u-actor')
    expect(m.saveName).toHaveBeenCalledWith('Kindred Labs', 'u-actor', { store: {} })
    expect(m.withDbUserIds).toEqual(['u-actor'])

    m.saveName.mockResolvedValue({ ok: false, error: 'Give the company a name.' })
    await expect(
      agentSettingsPort.apply({ setting: 'company_name', value: ' ' }, 'u-actor'),
    ).rejects.toMatchObject({ code: 'invalid_input', message: 'Give the company a name.' })
  })

  it('ai_active_provider switches on the owner’s account, and only where the deployment allows it', async () => {
    await agentSettingsPort.apply({ setting: 'ai_active_provider', value: 'openrouter' }, 'u-actor')
    expect(m.setActive).toHaveBeenCalledWith(expect.anything(), 'owner-1', 'openrouter')

    m.byokUi.mockReturnValue(false)
    await expect(
      agentSettingsPort.apply({ setting: 'ai_active_provider', value: 'eurouter' }, 'u-actor'),
    ).rejects.toMatchObject({ code: 'not_configured' })
  })

  it('ai_chat_model updates a saved provider row outside the pool namespace; OpenRouter, EUrouter and unsaved providers fail loud', async () => {
    m.updateReturning.mockResolvedValue([{ provider: 'mistral' }])
    await agentSettingsPort.apply(
      { setting: 'ai_chat_model', provider: 'mistral', value: 'mistral-large' },
      'u-actor',
    )
    expect(m.updateSet).toHaveBeenCalledWith(expect.objectContaining({ modelChat: 'mistral-large' }))

    // CB1: an OpenRouter key runs the company's chat slot; the free-text model is gone
    await expect(
      agentSettingsPort.apply({ setting: 'ai_chat_model', provider: 'openrouter', value: 'openai/gpt-x' }, 'u-actor'),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/ai_slot_model/) })

    await expect(
      agentSettingsPort.apply({ setting: 'ai_chat_model', provider: 'eurouter', value: 'x' }, 'u-actor'),
    ).rejects.toMatchObject({ code: 'invalid_input' })

    m.updateReturning.mockResolvedValue([])
    await expect(
      agentSettingsPort.apply({ setting: 'ai_chat_model', provider: 'mistral', value: 'x' }, 'u-actor'),
    ).rejects.toMatchObject({ code: 'invalid_input', details: { provider: 'mistral' } })
  })

  it('ai_chat_routing_rule sets the EUrouter chat rule', async () => {
    m.updateReturning.mockResolvedValue([{ provider: 'eurouter' }])
    await agentSettingsPort.apply({ setting: 'ai_chat_routing_rule', value: 'rule-9' }, 'u-actor')
    expect(m.updateSet).toHaveBeenCalledWith(expect.objectContaining({ ruleChat: 'rule-9' }))
  })
  it('ai_embedding_routing_rule sets the EUrouter embedding rule (Settings › AI saveModelConfig)', async () => {
    m.updateReturning.mockResolvedValue([{ provider: 'eurouter' }])
    await agentSettingsPort.apply({ setting: 'ai_embedding_routing_rule', value: 'rule-e' }, 'u-actor')
    expect(m.updateSet).toHaveBeenCalledWith(expect.objectContaining({ ruleEmbedding: 'rule-e' }))
  })
  it('ai_slot_model only takes a model from the pool (invalid input names the choices)', async () => {
    await expect(
      agentSettingsPort.apply({ setting: 'ai_slot_model', slot: 'chat', value: 'vendor/unvetted' }, 'u-actor'),
    ).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringMatching(/Choose one of/) })
  })
})
