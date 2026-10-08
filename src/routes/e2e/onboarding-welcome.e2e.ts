import { expect, test, type Page } from '@playwright/test'
import { loginUser, registerUser, signOut } from './test-helpers'

/**
 * Phase-2e: the boot sequence is the FIRST screen on `/` for every production
 * user who has not completed it — a cinematic first run (orb, greeting, name,
 * what this is), the provider connect as the only hard gate, and a handoff
 * into the chat where the agent's first words are already waiting. Skippable;
 * completion persists server-side per user; the saved name personalizes every
 * future boot ("Hello, Ada.").
 *
 * Runs against the unconfigured deployment (test.eigenlabs.dev → no platform provider),
 * so the mind step shows the real provider gate. All external provider
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

async function expectWizard(page: Page): Promise<void> {
  await expect(page.getByTestId('welcome-wizard')).toBeVisible({ timeout: 15_000 })
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
 * Walk the boot sequence: greet → name (when asked) → identity line 1 → line 2.
 * Waits for the name ask OR the identity line — whichever this user gets — so
 * the walk is deterministic regardless of the auto-advance timers.
 */
async function walkBoot(page: Page, name: string | null): Promise<void> {
  await expectWizard(page)
  await expect(page.getByText(/^Hello/)).toBeVisible()

  const identityLine = page.getByText('This is the operating system for your company.')
  const nameAsk = page.getByRole('textbox', { name: 'Your name' })

  await expect(identityLine.or(nameAsk)).toBeVisible({ timeout: 15_000 })
  if (name && (await nameAsk.isVisible())) {
    await nameAsk.fill(name)
    await nameAsk.press('Enter')
  }

  await expect(identityLine).toBeVisible({ timeout: 15_000 })
  await identityLine.click()
  await expect(page.getByText(/You talk\. It builds/)).toBeVisible({ timeout: 15_000 })
}

test.describe('welcome boot sequence', () => {
  test('boots, learns the name, connects the mind, and hands off into the chat', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // Boot → greeting. No capability list, no step counter, no module jargon — ever.
    await expectWizard(page)
    await expect(page.getByText('Step 1 of 5')).not.toBeVisible()
    await expect(page.getByText('Nucleus chat')).not.toBeVisible()
    await expect(page.getByText('Knowledge graph')).not.toBeVisible()

    await walkBoot(page, 'Ada')

    // The mind: the one hard gate (no platform provider in this deployment).
    await expect(page.getByText('First, it needs a mind to think with.')).toBeVisible({
      timeout: 20_000,
    })

    // Connect through the server contract (the provider wizard UI is covered by
    // its own component tests + onboarding-provider e2e).
    await saveApiKeyViaApi(page)
    await page.goto('/')

    // The mind gate is gone — the boot finishes in a Begin, straight into the chat.
    await walkBoot(page, null) // name known: no ask
    await expect(page.getByRole('button', { name: 'Begin' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Begin' }).click()

    // Handoff: the agent's first words are already there — seeded, personal, honest.
    await expectChatVisible(page)
    await expect(page.getByText(/Hello, Ada\. Your company's OS is getting set up/)).toBeVisible()
    await expect(
      page.getByText(/what's your company called, and what does it do\?/),
    ).toBeVisible()

    // Reload: the tour is done — the chat IS the page now.
    await page.goto('/')
    await expectChatVisible(page)
  })

  test('skipping persists across sign-out/sign-in; the provider gate still holds', async ({
    page,
    context,
  }) => {
    const { email } = await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    await expectWizard(page)
    await page.getByTestId('skip-onboarding').click()

    // Skipped, but no provider yet: the hard gate takes over — no provider, no
    // product. The boot sequence never comes back on top of it.
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

  test('restarting onboarding brings the boot back — and it knows your name', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // First pass: give the name, reach the mind gate, skip it — tour done, name saved.
    await walkBoot(page, 'Ada')
    await expect(page.getByText('First, it needs a mind to think with.')).toBeVisible({
      timeout: 20_000,
    })
    await page.getByTestId('skip-onboarding').click()

    // No provider yet: the hard gate takes over. Connect through the server contract.
    await expect(page.getByText('Connect your AI provider.')).toBeVisible({ timeout: 15_000 })
    await saveApiKeyViaApi(page)
    await page.goto('/')
    await expectChatVisible(page)

    // The cog is on the homepage; restart brings the boot sequence back.
    await page.getByTestId('home-settings-trigger').click()
    await page.getByTestId('restart-onboarding').click()
    await expectWizard(page)

    // Personalized greeting, no name ask — the name survived the restart.
    await expect(page.getByText('Hello, Ada.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Your name' })).not.toBeVisible()

    // And the boot still completes into the chat.
    await page.getByTestId('skip-onboarding').click()
    await expectChatVisible(page)
  })
})
