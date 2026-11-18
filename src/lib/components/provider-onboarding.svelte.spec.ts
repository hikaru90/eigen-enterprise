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

// Model lists for the subscription sign-ins (from models.dev).
const MODEL_LISTS: Record<string, { chatModels: CatalogModelLike[]; embeddingModels: CatalogModelLike[] }> = {
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

  it('the subscription card names only real subscriptions (OpenRouter is pay-per-use, not one)', async () => {
    renderWizard({ byokUiEnabled: true })
    const subscription = page.getByRole('button', { name: /Use a subscription I have/ })
    await expect.element(subscription).toHaveTextContent(/Copilot/)
    await expect.element(subscription).not.toHaveTextContent(/OpenRouter/)
    await expect
      .element(page.getByRole('button', { name: /Use an API key/ }))
      .toHaveTextContent(/OpenRouter/)
  })

  it('lists only the tool-capable subscription sign-ins (no Claude / ChatGPT: their API shapes carry no tool calls; no OpenRouter: an API key)', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use a subscription I have').click()
    await expect.element(page.getByText('Claude Pro/Max')).not.toBeInTheDocument()
    await expect.element(page.getByText('ChatGPT Plus/Pro')).not.toBeInTheDocument()
    await expect.element(page.getByText('GitHub Copilot')).toBeInTheDocument()
    await expect.element(page.getByText(/OpenRouter/)).not.toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /Groq/ })).not.toBeInTheDocument()
  })

  it('offers the OpenRouter sign-in on the API-key path, with model selection before the redirect', async () => {
    renderWizard({ byokUiEnabled: true })
    await page.getByText('Use an API key').click()
    await page.getByRole('button', { name: /Sign in to OpenRouter to create a key/ }).click()
    const orChat = page.getByRole('combobox', { name: 'Chat model' })
    await expect.element(orChat).toBeInTheDocument()
    await orChat.fill('mock/openrouter-chat')
    await expect.element(page.getByRole('button', { name: 'Continue' })).toBeEnabled()
    // No sign-in redirect before the model is picked — the step is still the model list.
    await expect.element(orChat).toBeInTheDocument()
    // Back leads to the API-key providers, where the sign-in lives now.
    await page.getByRole('button', { name: /Back/ }).click()
    await expect.element(page.getByRole('button', { name: /EUrouter/ })).toBeInTheDocument()
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
