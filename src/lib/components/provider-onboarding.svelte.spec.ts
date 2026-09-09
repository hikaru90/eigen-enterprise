import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

vi.mock('$lib/analytics/posthog-client', () => ({
  capture: () => undefined,
}))

import ProviderOnboarding from './provider-onboarding.svelte'

const mounted: Array<() => void> = []

const CATALOG = {
  source: 'models.dev',
  providers: [
    {
      id: 'eurouter',
      name: 'EUrouter',
      baseUrl: 'https://api.eurouter.ai/v1',
      envVar: 'SERVICE_API_KEY_EUROUTER',
      docUrl: null,
      chatModels: [],
      embeddingModels: [],
    },
    {
      id: 'groq',
      name: 'Groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      envVar: 'GROQ_API_KEY',
      docUrl: null,
      chatModels: [{ id: 'llama-3.3-70b', name: 'Llama 3.3 70B' }],
      embeddingModels: [],
    },
    {
      id: 'openai',
      name: 'OpenAI',
      baseUrl: 'https://api.openai.com/v1',
      envVar: 'OPENAI_API_KEY',
      docUrl: null,
      chatModels: [{ id: 'gpt-4o-mini', name: 'GPT-4o mini' }],
      embeddingModels: [{ id: 'text-embedding-3-small', name: 'text-embedding-3-small' }],
    },
  ],
}

// Model lists for subscription providers (anthropic / openai-codex come from
// models.dev even though their API shape is not on the API-key path).
const MODEL_LISTS: Record<string, { chatModels: CatalogModelLike[]; embeddingModels: CatalogModelLike[] }> = {
  anthropic: {
    chatModels: [
      { id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5' },
      { id: 'claude-opus-4-8', name: 'Claude Opus 4.8' },
    ],
    embeddingModels: [],
  },
  'openai-codex': {
    chatModels: [{ id: 'gpt-5.1-codex', name: 'GPT-5.1 Codex' }],
    embeddingModels: [],
  },
  openrouter: {
    chatModels: [{ id: 'mock/openrouter-chat', name: 'Mock OpenRouter Chat' }],
    embeddingModels: [],
  },
}

type CatalogModelLike = { id: string; name: string }

function catalogModelsResponse(provider: string) {
  const lists = MODEL_LISTS[provider]
  return {
    ok: Boolean(lists),
    status: lists ? 200 : 404,
    json: async () => lists ?? { error: `Unknown provider: ${provider}` },
  } as unknown as Response
}

describe('provider-onboarding.svelte', () => {
  // vitest-browser-svelte does not auto-cleanup — stacked components poison strict locators.
  function renderWizard(props: { byokUiEnabled?: boolean }) {
    const result = render(ProviderOnboarding, props)
    mounted.push(() => result.unmount())
    return result
  }
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        const path = String(input)
        if (path === '/api/onboarding/catalog') {
          return { ok: true, status: 200, json: async () => CATALOG } as unknown as Response
        }
        if (path.startsWith('/api/onboarding/catalog/models?provider=')) {
          return catalogModelsResponse(
            new URL(path, 'http://x').searchParams.get('provider') ?? '',
          )
        }
        if (path === '/api/onboarding/oauth/anthropic/authorize') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://claude.ai/oauth/authorize?mock=1' }),
          } as unknown as Response
        }
        if (path === '/api/onboarding/oauth/openai/start') {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              deviceAuthId: 'dev-1',
              userCode: 'TEST-CODE',
              verificationUri: 'https://auth.openai.com/codex/device',
              intervalSeconds: 1,
              expiresInSeconds: 900,
            }),
          } as unknown as Response
        }
        if (path === '/api/onboarding/openrouter/authorize') {
          return {
            ok: true,
            status: 200,
            json: async () => ({ url: 'https://openrouter.ai/auth?mock=1' }),
          } as unknown as Response
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    while (mounted.length) mounted.pop()!()
  })

  it('opens with the method question — subscription or API key', async () => {
    renderWizard({ byokUiEnabled: true })
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await expect.element(page.getByText('Use a subscription I have')).toBeInTheDocument()
    await expect.element(page.getByText('Use an API key')).toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'API key' })).not.toBeInTheDocument()
  })

  it('lists subscription providers including Claude and ChatGPT', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use a subscription I have').click()
    await expect.element(page.getByText('Claude Pro/Max')).toBeInTheDocument()
    await expect.element(page.getByText('ChatGPT Plus/Pro')).toBeInTheDocument()
    await expect.element(page.getByText('GitHub Copilot')).toBeInTheDocument()
    await expect.element(page.getByText(/Sign in with OpenRouter/)).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /Groq/ })).not.toBeInTheDocument()
  })

  it('requires an explicit chat model for Claude before the sign-in card', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use a subscription I have').click()
    await page.getByText('Claude Pro/Max').click()

    // Model step first — no implicit default model; Continue stays disabled until picked.
    const chatModel = page.getByRole('combobox', { name: 'Chat model' })
    await expect.element(chatModel).toBeInTheDocument()
    await expect.element(chatModel).toHaveValue('')
    const continueBtn = page.getByRole('button', { name: 'Continue' })
    await expect.element(continueBtn).toBeDisabled()

    await chatModel.fill('claude-sonnet-4-5')
    await expect.element(continueBtn).toBeEnabled()
    await continueBtn.click()
    // Now the paste-code card appears.
    await expect
      .element(page.getByRole('textbox', { name: 'Authorization code' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByText(/Claude sign-in page opened/i))
      .toBeInTheDocument()
  })

  it('shows the ChatGPT device code after the model step', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use a subscription I have').click()
    await page.getByText('ChatGPT Plus/Pro').click()
    await page.getByRole('combobox', { name: 'Chat model' }).fill('gpt-5.1-codex')
    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.element(page.getByText('TEST-CODE')).toBeInTheDocument({ timeout: 10_000 })
  })

  it('shows OpenRouter model selection before the sign-in redirect', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use a subscription I have').click()
    await page.getByText(/Sign in with OpenRouter/).click()
    const orChat = page.getByRole('combobox', { name: 'Chat model' })
    await expect.element(orChat).toBeInTheDocument()
    await orChat.fill('mock/openrouter-chat')
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
    // No sign-in redirect before the model is picked — the step is still the model list.
    await expect.element(orChat).toBeInTheDocument()
  })

  it('lists catalog providers on the API-key path with EMPTY model inputs', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use an API key').click()
    await expect.element(page.getByRole('button', { name: /EUrouter/ })).toBeInTheDocument()
    await page.getByRole('button', { name: /Groq/ }).click()
    const baseUrl = page.getByRole('textbox', { name: 'Base URL' })
    await expect.element(baseUrl).toHaveValue('https://api.groq.com/openai/v1')
    // No implicit default model — explicit selection only. Groq has no embedding
    // models in the catalog: no embedding field, honest note instead.
    const chatModel = page.getByRole('combobox', { name: 'Chat model' })
    await expect.element(chatModel).toHaveValue('')
    await expect
      .element(page.getByRole('combobox', { name: 'Embedding model' }))
      .not.toBeInTheDocument()
  })

  it('shows the embedding model field for embedding-capable providers', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use an API key').click()
    await page.getByRole('button', { name: /OpenAI/ }).click()
    const embedding = page.getByRole('combobox', { name: 'Embedding model' })
    await expect.element(embedding).toBeInTheDocument()
    await expect.element(embedding).toHaveValue('')
  })

  it('shows the operator hint instead of the flow when the BYOK UI is disabled', async () => {
    renderWizard({ byokUiEnabled: false })
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await expect.element(page.getByText('Use an API key')).not.toBeInTheDocument()
    await expect
      .element(page.getByText('Use a subscription I have'))
      .not.toBeInTheDocument()
  })
})
