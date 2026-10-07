import { expect, test, type Page } from '@playwright/test'
import { loginUser, registerUser, signOut } from './test-helpers'

/**
 * Phase-1e: the welcome setup wizard is the FIRST screen on `/` for every production
 * user who has not completed it — it explains what the system is, what it can do,
 * connects the AI (hard gate, reusing the provider wizard), and asks what the user
 * wants to do first. Skippable; completion persists server-side per user.
 *
 * Runs against the unconfigured deployment (test.eigenlabs.dev → no platform provider),
 * so the wizard's connect step shows the real provider gate. All external provider
 * calls resolve against scripts/mock-gateway.mjs via env overrides.
 */

// Must match the mock gateway port playwright's webServer starts (playwright.config.ts).
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const CHAT_MODEL = 'mock-chat-model'
const EMBED_MODEL = 'mock-embed-model'

async function expectChatVisible(page: Page): Promise<void> {
  await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('welcome-wizard')).not.toBeVisible()
}

async function expectWelcomeStep(page: Page, step: string): Promise<void> {
  await expect(page.getByTestId('welcome-wizard')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText(step)).toBeVisible()
}

async function saveApiKeyViaApi(page: Page): Promise<void> {
  const saved = await page.request.post('/api/onboarding/provider', {
    data: {
      provider: 'openrouter',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: CHAT_MODEL,
      modelEmbedding: EMBED_MODEL,
    },
  })
  expect(saved.status()).toBe(200)
}

/**
 * A Continue click racing hydration does nothing (SSR button, no handlers yet).
 * Click and verify the step actually advanced; retry until stable — same discipline
 * as fillCaptureComposer in release-helpers.
 */
async function continueToStep(page: Page, nextStep: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt++) {
    await page.getByRole('button', { name: 'Continue' }).click()
    try {
      await expect(page.getByText(nextStep)).toBeVisible({ timeout: 2_000 })
      return
    } catch {
      // Not advanced yet — hydration may not have attached handlers; click again.
    }
  }
  throw new Error(`Continue never reached "${nextStep}"`)
}

test.describe('welcome setup wizard', () => {
  test('first screen explains the system, walks to the chat, and never returns', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // Step 1 — what this is (in plain words), not a bare chatbox.
    await expectWelcomeStep(page, 'Step 1 of 5')
    await expect(page.getByText("your company's operating system")).toBeVisible()

    // Step 2 — what it can do.
    await continueToStep(page, 'Step 2 of 5')
    await expect(page.getByText('Here is what it can do.')).toBeVisible()

    // Step 3 — the AI brain: a hard gate, the provider wizard itself, no skip.
    await continueToStep(page, 'Step 3 of 5')
    await expect(page.getByText('Connect your AI provider.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Skip setup' })).not.toBeVisible()

    // Connect through the server contract (wizard UI covered by component tests)…
    await saveApiKeyViaApi(page)

    // …then the step flips to connected on a fresh load (data is the source of truth).
    await page.goto('/')
    await expectWelcomeStep(page, 'Step 1 of 5')
    await continueToStep(page, 'Step 2 of 5')
    await continueToStep(page, 'Step 3 of 5')
    await expect(page.getByText('Your AI is connected.')).toBeVisible()

    // Step 4 — the founding interview lives in onboarding now, not the chat.
    await continueToStep(page, 'Step 4 of 5')
    await expect(page.getByText('Tell me about your company.')).toBeVisible()

    // Step 5 — what do you want first? Entering the chat completes the tour.
    await continueToStep(page, 'Step 5 of 5')
    await page.getByRole('button', { name: 'Start with the chat' }).click()
    await expectChatVisible(page)

    // Reload: the tour is done — the chat IS the page now.
    await page.goto('/')
    await expectChatVisible(page)
  })

  test('skipping persists across sign-out/sign-in; the provider gate still holds', async ({
    page,
    context,
  }) => {
    const { email } = await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    await expectWelcomeStep(page, 'Step 1 of 5')
    await page.getByRole('button', { name: 'Skip setup' }).click()

    // Tour skipped, but no provider yet: the phase-1d hard gate takes over — no
    // provider, no product. The tour never comes back on top of it.
    await expect(page.getByText('Connect your AI provider.')).toBeVisible({ timeout: 15_000 })
    await expect(page.getByTestId('welcome-wizard')).not.toBeVisible()

    await saveApiKeyViaApi(page)
    await page.goto('/')
    await expectChatVisible(page)

    // The skip decision survives a full sign-out/sign-in cycle (server-side flag).
    await signOut(page)
    await loginUser(page, email)

    await expectChatVisible(page)
    await expect(page.getByTestId('welcome-wizard')).not.toBeVisible()
  })

  test('destination cards complete the tour and navigate', async ({ page, context }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // Walk to the connect step; the provider gate itself is covered by the other tests.
    await expectWelcomeStep(page, 'Step 1 of 5')
    await saveApiKeyViaApi(page)
    await page.goto('/')
    await continueToStep(page, 'Step 2 of 5')
    await continueToStep(page, 'Step 3 of 5')
    await continueToStep(page, 'Step 4 of 5')
    await continueToStep(page, 'Step 5 of 5')

    // Step 5: picking a destination persists the tour, then navigates.
    await expectWelcomeStep(page, 'Step 5 of 5')
    await page.getByRole('button', { name: 'Capture a thought' }).click()

    await expect(page).toHaveURL(/\/capture/)
    await expect(page.getByTestId('welcome-wizard')).not.toBeVisible()

    // Back home: the tour is done — the chat, not the wizard.
    await page.goto('/')
    await expectChatVisible(page)
  })

  test('the homepage settings cog restarts onboarding — the wizard returns', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    await expectWelcomeStep(page, 'Step 1 of 5')
    await page.getByRole('button', { name: 'Skip setup' }).click()
    await expect(page.getByText('Connect your AI provider.')).toBeVisible({ timeout: 15_000 })

    // Finish provider setup so the chat is the homepage.
    await saveApiKeyViaApi(page)
    await page.goto('/')
    await expectChatVisible(page)

    // The cog is on the homepage; restart brings the wizard back.
    await page.getByTestId('home-settings-trigger').click()
    await page.getByTestId('restart-onboarding').click()
    await expect(page.getByTestId('welcome-wizard')).toBeVisible({ timeout: 15_000 })

    // The restarted tour is the real thing: 5 steps, founding interview inside.
    await expectWelcomeStep(page, 'Step 1 of 5')
  })
})
