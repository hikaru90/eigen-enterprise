import { expect, test, type Locator, type Page } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * Phase-2a: provider onboarding is two questions (method → provider), catalog-driven.
 *
 * The e2e server overrides MODELS_DEV_CATALOG_URL / OAUTH_GITHUB_* to the mock gateway
 * (scripts/mock-gateway.mjs), so the FULL subscription flow (GitHub device code →
 * Copilot token) and the API-key flow (real 1-token gateway test) run end-to-end
 * against deterministic fixtures.
 *
 * Wizard visibility depends on the deployment's platform env (LLM_BASE_URL …): a
 * configured deployment never shows the wizard — both shapes are asserted.
 */

const GATEWAY_BASE_URL = 'http://127.0.0.1:5199/v1' // scripts/mock-gateway.mjs

/** waitFor-based visibility probe — isVisible() returns instantly and races hydration. */
async function appearsWithin(locator: Locator, timeoutMs = 5_000): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/** Fill that survives Svelte hydration: verify the value stuck, retry if it was wiped. */
async function fillPersisted(locator: Locator, value: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await locator.fill(value)
    if ((await locator.inputValue()) === value) return
    await locator.waitFor({ state: 'visible' })
    await locator.page().waitForTimeout(400)
  }
  throw new Error(`fill did not persist for ${JSON.stringify(value)}`)
}

async function expectChatVisible(page: Page): Promise<void> {
  await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Connect your AI provider.')).not.toBeVisible()
}

async function connectViaCopilotWizard(page: Page): Promise<void> {
  await page.getByText('Use a subscription I have').click()
  await page.getByText('GitHub Copilot').click()
  // Device flow: the one-time code shows while the wizard polls (the stub completes
  // on the second poll, so the code may disappear quickly — either state is valid).
  await expect(page.getByText('TEST-CODE').or(page.getByText('Connected.'))).toBeVisible({
    timeout: 30_000,
  })
  await expect(page.getByText('Connected.')).toBeVisible({ timeout: 30_000 })
  await page.getByRole('button', { name: 'Enter the workspace →' }).click()
  await expectChatVisible(page)
}

async function connectViaApiKeyWizard(page: Page): Promise<void> {
  await page.getByText('Use an API key').click()
  await page.getByRole('button', { name: /MockGroq/ }).click()
  // Base URL comes prefilled from the catalog fixture.
  const baseUrl = page.getByRole('textbox', { name: 'Base URL' })
  await expect(baseUrl).toHaveValue(GATEWAY_BASE_URL)
  await fillPersisted(page.getByRole('textbox', { name: 'API key' }), `e2e-key-${Date.now()}`)
  await expect(page.getByRole('combobox', { name: 'Chat model' })).toHaveValue('mock-chat-model')
  await expect(page.getByRole('combobox', { name: 'Embedding model' })).toHaveValue(
    'mock-embed-model',
  )
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected.')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Enter the workspace →' }).click()
  await expectChatVisible(page)
}

async function resetOnboardingViaSettings(page: Page): Promise<void> {
  await page.goto('/settings')
  const form = page.locator('form[action*="resetOnboarding"]')
  await expect(form).toBeVisible()
  await form.locator('button').click()
  await page.waitForURL(/\/(\?|#|$)/)
}

test.describe('nucleus first-run onboarding', () => {
  test('harness user opens straight into the chat — never the wizard', async ({
    page,
    context,
  }) => {
    await registerUser(context, page)
    await expectChatVisible(page)
  })

  test('unconfigured deployment: the wizard is the first screen; Copilot sign-in connects', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    const wizardShown = await appearsWithin(page.getByText('Connect your AI provider.'))
    if (wizardShown) {
      // The wizard replaces the chatbox entirely until a provider works.
      await expect(page.getByPlaceholder('What do you need?')).not.toBeVisible()
      await connectViaCopilotWizard(page)
    } else {
      // Configured deployment: chat directly, no wizard, ever.
      await expectChatVisible(page)
    }
  })

  test('API-key path: catalog provider, real gateway test, then chat', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    const wizardShown = await appearsWithin(page.getByText('Connect your AI provider.'))
    if (wizardShown) {
      await connectViaApiKeyWizard(page)
    } else {
      // Configured deployment: prove the same save path via the settings form.
      await page.goto('/settings/llm/byok/openrouter')
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
      await fillPersisted(page.getByRole('textbox', { name: 'Base URL' }), GATEWAY_BASE_URL)
      await fillPersisted(page.getByRole('textbox', { name: 'API key' }), `e2e-key-${Date.now()}`)
      await fillPersisted(page.getByRole('combobox', { name: 'Chat model' }), 'mock-chat-model')
      await fillPersisted(
        page.getByRole('combobox', { name: 'Embedding model' }),
        'mock-embed-model',
      )
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('link', { name: /OpenRouter Active/ })).toBeVisible({
        timeout: 15_000,
      })
    }
  })

  test('once credentials exist the wizard never comes back', async ({ page, context }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    const wizardShown = await appearsWithin(page.getByText('Connect your AI provider.'))
    if (wizardShown) {
      await connectViaApiKeyWizard(page)
    } else {
      await page.goto('/settings/llm/byok/openrouter')
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
      await fillPersisted(page.getByRole('textbox', { name: 'Base URL' }), GATEWAY_BASE_URL)
      await fillPersisted(page.getByRole('textbox', { name: 'API key' }), `e2e-key-${Date.now()}`)
      await fillPersisted(page.getByRole('combobox', { name: 'Chat model' }), 'mock-chat-model')
      await fillPersisted(
        page.getByRole('combobox', { name: 'Embedding model' }),
        'mock-embed-model',
      )
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('link', { name: /OpenRouter Active/ })).toBeVisible({
        timeout: 15_000,
      })
    }

    await resetOnboardingViaSettings(page)
    await expectChatVisible(page)
  })
})
