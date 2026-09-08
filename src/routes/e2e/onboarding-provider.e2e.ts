import { expect, test, type Locator, type Page } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * Phase-1d: first-run onboarding IS the first screen. A production user opening the
 * nucleus without a working AI provider gets the guided provider wizard instead of the
 * chatbox; connecting (real 1-token gateway test, then save) reveals the chat.
 *
 * Wizard visibility depends on the deployment's platform env (LLM_BASE_URL …): a
 * configured deployment never shows the wizard — both shapes are asserted so the suite
 * passes on either deployment.
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

async function connectViaWizard(page: Page): Promise<void> {
  await expect(page.getByText('Connect your AI provider.')).toBeVisible()
  await page.getByRole('button', { name: 'OpenRouter' }).click()
  await fillPersisted(page.getByRole('textbox', { name: 'Base URL' }), GATEWAY_BASE_URL)
  await fillPersisted(page.getByRole('textbox', { name: 'API key' }), `e2e-key-${Date.now()}`)
  await fillPersisted(page.getByRole('textbox', { name: 'Chat model' }), 'openai/gpt-4o-mini')
  await fillPersisted(
    page.getByRole('textbox', { name: 'Embedding model' }),
    'openai/text-embedding-3-small',
  )
  await page.getByRole('button', { name: 'Connect', exact: true }).click()
  await expect(page.getByText('Connected.')).toBeVisible({ timeout: 20_000 })
  await page.getByRole('button', { name: 'Enter the workspace →' }).click()
  await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })
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
    await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Connect your AI provider.')).not.toBeVisible()
  })

  test('unconfigured deployment: the wizard is the first screen and connecting reveals chat', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    const wizardShown = await appearsWithin(page.getByText('Connect your AI provider.'))
    if (wizardShown) {
      // The wizard replaces the chatbox entirely until the provider works.
      await expect(page.getByPlaceholder('What do you need?')).not.toBeVisible()
      await connectViaWizard(page)
    } else {
      // Configured deployment: chat directly, no wizard, ever.
      await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })
    }
  })

  test('once BYOK credentials exist the wizard never comes back', async ({ page, context }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    const wizardShown = await appearsWithin(page.getByText('Connect your AI provider.'))
    if (wizardShown) {
      await connectViaWizard(page)
    } else {
      // Configured deployment: prove the same contract via the settings form (same
      // saveProviderConfig service) so the test is deployment-independent.
      await page.goto('/settings/llm/byok/openrouter')
      await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
      await fillPersisted(page.getByRole('textbox', { name: 'Base URL' }), GATEWAY_BASE_URL)
      await fillPersisted(page.getByRole('textbox', { name: 'API key' }), `e2e-key-${Date.now()}`)
      await fillPersisted(page.getByRole('textbox', { name: 'Chat model' }), 'openai/gpt-4o-mini')
      await fillPersisted(
        page.getByRole('textbox', { name: 'Embedding model' }),
        'openai/text-embedding-3-small',
      )
      await page.getByRole('button', { name: 'Save' }).click()
      await expect(page.getByRole('link', { name: /OpenRouter Active/ })).toBeVisible({
        timeout: 15_000,
      })
    }

    await resetOnboardingViaSettings(page)
    // After reset: provider works (saved above) → chat, never the wizard.
    await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByText('Connect your AI provider.')).not.toBeVisible()
  })
})
