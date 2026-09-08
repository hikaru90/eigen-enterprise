import { expect, test, type Locator, type Page } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * Phase-1c: the onboarding provider step. A fresh user on a deployment without a
 * configured inference provider is offered "Connect your AI provider" during onboarding
 * and can save BYOK credentials inline (same persistence path as Settings → LLM).
 *
 * Branch visibility depends on the deployment's platform env (LLM_BASE_URL …): when the
 * platform service account is configured, the step is skipped entirely — both shapes are
 * asserted so the suite passes on either deployment.
 */

const OPENROUTER_BASE_URL = 'https://test.example/openrouter/api/v1'

/** waitFor-based visibility probe — isVisible() returns instantly and races hydration. */
async function appearsWithin(
  locator: Locator,
  timeoutMs = 5_000,
): Promise<boolean> {
  try {
    await locator.waitFor({ state: 'visible', timeout: timeoutMs })
    return true
  } catch {
    return false
  }
}

/**
 * Fill that survives Svelte hydration: a pre-hydration fill is clobbered when the
 * component mounts, so verify the value stuck and retry if it was wiped.
 */
async function fillPersisted(locator: Locator, value: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await locator.fill(value)
    if ((await locator.inputValue()) === value) return
    await locator.waitFor({ state: 'visible' })
    await locator.page().waitForTimeout(400)
  }
  throw new Error(`fill did not persist for ${JSON.stringify(value)}`)
}

async function walkToProviderStep(page: Page): Promise<boolean> {
  await expect(page.getByRole('dialog')).toBeVisible()
  await expect(page.getByText('Your memory, not theirs.')).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  await expect(page.getByText('Just drop it in.')).toBeVisible()
  await page.getByRole('button', { name: 'Next' }).click()
  return appearsWithin(page.getByText('Connect your AI provider.'))
}

async function saveOpenRouterProvider(page: Page): Promise<void> {
  await expect(page.getByText('Step 3 of 4')).toBeVisible()

  await page.getByRole('button', { name: 'OpenRouter' }).click()
  await fillPersisted(page.getByRole('textbox', { name: 'Base URL' }), OPENROUTER_BASE_URL)
  await fillPersisted(page.getByRole('textbox', { name: 'API key' }), `e2e-key-${Date.now()}`)
  await fillPersisted(page.getByRole('textbox', { name: 'Chat model' }), 'openai/gpt-4o-mini')
  await fillPersisted(
    page.getByRole('textbox', { name: 'Embedding model' }),
    'openai/text-embedding-3-small',
  )
  await page.getByRole('button', { name: 'Connect provider' }).click()

  await expect(page.getByText('Provider connected.')).toBeVisible({ timeout: 15_000 })
}

async function completeOnboarding(page: Page): Promise<void> {
  // Advance to notifications and finish.
  await page.getByRole('button', { name: 'Next' }).click()
  const continueWithout = page.getByRole('button', { name: 'Continue without notifications' })
  if (await appearsWithin(continueWithout)) {
    await continueWithout.click()
  } else {
    await page.getByRole('button', { name: 'Start capturing →' }).click()
  }
  await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 })
}

async function resetOnboardingViaSettings(page: Page): Promise<void> {
  await page.goto('/settings')
  const form = page.locator('form[action*="resetOnboarding"]')
  await expect(form).toBeVisible()
  await form.locator('button').click()
  await page.waitForURL(/\/capture/)
  await expect(page.getByRole('dialog')).toBeVisible()
}

test.describe('onboarding provider setup', () => {
  test('fresh unconfigured user is offered the provider step and can connect inline', async ({
    page,
    context,
  }) => {
    // Warm the signup page first — the shared registerUser helper fills fields that a
    // cold-hydrating page would wipe.
    await page.goto('/signup')
    await page.waitForLoadState('networkidle')
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    const offered = await walkToProviderStep(page)
    if (offered) {
      // Unconfigured deployment: provider step sits between capture and notifications.
      await saveOpenRouterProvider(page)
    } else {
      // Platform provider already configured: capture flows straight to notifications.
      await expect(page.getByText('Stay in the loop')).toBeVisible()
      await expect(page.getByText('Step 3 of 3')).toBeVisible()
    }
    await completeOnboarding(page)
  })

  test('provider step disappears once BYOK credentials are saved', async ({ page, context }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // Save BYOK credentials through Settings → LLM (same saveProviderConfig service the
    // onboarding step uses) so this contract holds on ANY deployment, configured or not.
    await page.goto('/settings/llm/byok/openrouter')
    await expect(page.getByRole('button', { name: 'Save' })).toBeVisible()
    await fillPersisted(page.getByRole('textbox', { name: 'Base URL' }), OPENROUTER_BASE_URL)
    await fillPersisted(page.getByRole('textbox', { name: 'API key' }), `e2e-key-${Date.now()}`)
    await fillPersisted(page.getByRole('textbox', { name: 'Chat model' }), 'openai/gpt-4o-mini')
    await fillPersisted(
      page.getByRole('textbox', { name: 'Embedding model' }),
      'openai/text-embedding-3-small',
    )
    await page.getByRole('button', { name: 'Save' }).click()
    // The settings form redirects to the overview on success — "Active" is the signal.
    await expect(page.getByRole('link', { name: /OpenRouter Active/ })).toBeVisible({
      timeout: 15_000,
    })

    // Reveal onboarding again: readiness must now be satisfied by the saved config.
    await resetOnboardingViaSettings(page)
    await expect(page.getByText('Your memory, not theirs.')).toBeVisible()
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect(page.getByText('Stay in the loop')).toBeVisible()
    await expect(page.getByText('Connect your AI provider.')).not.toBeVisible()
    await expect(page.getByText('Step 3 of 3')).toBeVisible()
  })

  test('provider step is skippable — onboarding completes without a provider', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    const offered = await walkToProviderStep(page)
    if (offered) {
      // Skip on the provider step itself.
      await page.getByRole('button', { name: 'Skip for now' }).click()
    } else {
      await completeOnboarding(page)
    }
    await expect(page.getByRole('dialog')).not.toBeVisible({ timeout: 15_000 })
  })
})
