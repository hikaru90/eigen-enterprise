import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

vi.mock('$lib/analytics/posthog-client', () => ({
  capture: () => undefined,
}))

import ProviderOnboarding from './provider-onboarding.svelte'

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

describe('provider-onboarding.svelte', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string | URL) => {
        if (String(input) === '/api/onboarding/catalog') {
          return { ok: true, status: 200, json: async () => CATALOG } as unknown as Response
        }
        return { ok: false, status: 404, json: async () => ({}) } as unknown as Response
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('opens with the method question — subscription or API key', async () => {
    render(ProviderOnboarding, { byokUiEnabled: true })
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await expect
      .element(page.getByText('Use a subscription I have'))
      .toBeInTheDocument()
    await expect.element(page.getByText('Use an API key')).toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'API key' })).not.toBeInTheDocument()
  })

  it('lists catalog providers on the API-key path and prefills the form', async () => {
    render(ProviderOnboarding, { byokUiEnabled: true })
    await page.getByText('Use an API key').click()
    await expect.element(page.getByRole('button', { name: /EUrouter/ })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /Groq/ })).toBeInTheDocument()

    await page.getByRole('button', { name: /Groq/ }).click()
    const baseUrl = page.getByRole('textbox', { name: 'Base URL' })
    await expect.element(baseUrl).toHaveValue('https://api.groq.com/openai/v1')
    const chatModel = page.getByRole('combobox', { name: 'Chat model' })
    await expect.element(chatModel).toHaveValue('llama-3.3-70b')
    // Groq has no embedding models in the catalog: no embedding field, honest note instead.
    await expect
      .element(page.getByRole('combobox', { name: 'Embedding model' }))
      .not.toBeInTheDocument()
    await expect
      .element(page.getByText(/no embedding models/i))
      .toBeInTheDocument()
  })

  it('shows the embedding model field for embedding-capable providers', async () => {
    render(ProviderOnboarding, { byokUiEnabled: true })
    await page.getByText('Use an API key').click()
    await page.getByRole('button', { name: /OpenAI/ }).click()
    await expect
      .element(page.getByRole('combobox', { name: 'Embedding model' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('combobox', { name: 'Chat model' }))
      .toHaveValue('gpt-4o-mini')
  })

  it('lists subscription providers on the subscription path', async () => {
    render(ProviderOnboarding, { byokUiEnabled: true })
    await page.getByText('Use a subscription I have').click()
    await expect
      .element(page.getByText('GitHub Copilot', { exact: false }))
      .toBeInTheDocument()
    await expect.element(page.getByText(/Sign in with OpenRouter/)).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: /Groq/ })).not.toBeInTheDocument()
  })

  it('shows the operator hint instead of the flow when the BYOK UI is disabled', async () => {
    render(ProviderOnboarding, { byokUiEnabled: false })
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    // Hint branch: neither connect method is offered.
    await expect.element(page.getByText('Use an API key')).not.toBeInTheDocument()
    await expect
      .element(page.getByText('Use a subscription I have'))
      .not.toBeInTheDocument()
  })
})
