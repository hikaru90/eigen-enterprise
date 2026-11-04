import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileStepInUi, loginUser, registerUser, signOut } from './test-helpers'

/**
 * Phase-2e: the boot sequence is the FIRST screen on `/` for every production
 * user who has not completed it — a cinematic first run (orb, greeting, name,
 * what this is), the provider connect as the only hard gate, and a handoff
 * into the app: the dashboard, with the assistant panel opened on its own and
 * the agent's first words streaming into it (polish P-1/P-2). Skippable;
 * completion persists server-side per user; the saved name personalizes every
 * future boot ("Hello, Ada."). The name (and picture) come from the required
 * profile step before it (P-5), which replaced the boot's own name ask.
 *
 * Runs against the unconfigured deployment (test.eigenlabs.dev → no platform provider),
 * so the mind step shows the real provider gate. All external provider
 * calls resolve against scripts/mock-gateway.mjs via env overrides.
 */

// Must match the mock gateway port playwright's webServer starts (playwright.config.ts).
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const CHAT_MODEL = 'mock-chat-model'
const EMBED_MODEL = 'mock-embed-model'

/**
 * Deterministic voice pin, two sides:
 *  - the robot voice is GONE: speechSynthesis is replaced with a recorder that
 *    must stay EMPTY — the browser never speaks;
 *  - the assistant's voice is the GATEWAY: /api/tts intercept captures what
 *    the client asks the gateway to say (fulfilled with an error so the client
 *    takes its honest silence path — the audio bytes themselves are pinned by
 *    unit specs, not the browser).
 */
/** The mind gate's heading (welcome-wizard.svelte MIND_HEADING). */
const MIND_HEADING = 'Now, it needs a mind to think with.'

/**
 * The boot's remaining identity lines (the modular-system lines): Continue
 * until the mind gate shows or the last line turns into Begin.
 */
async function continueThroughLines(page: Page): Promise<void> {
  const mind = page.getByText(MIND_HEADING)
  const begin = page.getByRole('button', { name: 'Begin' })
  const next = page.getByTestId('onboarding-continue')
  for (let i = 0; i < 10; i++) {
    await expect(mind.or(begin).or(next).first()).toBeVisible({ timeout: 15_000 })
    if ((await mind.isVisible()) || (await begin.isVisible())) return
    await next.click()
  }
  throw new Error('the boot never reached the mind gate or Begin')
}

async function stubSpeechSynthesis(context: import('@playwright/test').BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    const spoken: string[] = []
    const recorder = {
      speak: (utterance: { text: string }) => {
        spoken.push(utterance.text)
      },
      cancel: () => {},
      speaking: false,
      pending: false,
      paused: false,
      pause: () => {},
      resume: () => {},
      getVoices: () => [],
      onvoiceschanged: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }
    Object.defineProperty(window, 'speechSynthesis', { value: recorder, configurable: true })
    Object.defineProperty(window, '__ttsSpoken', { value: spoken, configurable: true })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', {
      value: class {
        text: string
        rate = 1
        constructor(text: string) {
          this.text = text
        }
      },
      configurable: true,
    })
  })
}

async function interceptTts(context: import('@playwright/test').BrowserContext): Promise<{ texts: string[] }> {
  const texts: string[] = []
  await context.route('**/api/tts', async (route) => {
    const request = route.request()
    if (request.method() === 'POST') {
      const body = request.postDataJSON() as { text?: string } | null
      if (typeof body?.text === 'string') texts.push(body.text)
    }
    // The gateway cannot speak in this environment — the client's honest
    // silence path runs, and the boot flow must not care.
    await route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":"no speech route"}' })
  })
  return { texts }
}

/** After the first run: the dashboard in the shell, the assistant one field away. */
async function expectHomeVisible(page: Page): Promise<void> {
  await expect(page.getByTestId('dashboard')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByTestId('assistant-bar-input')).toBeVisible()
  await expect(page.getByTestId('welcome-wizard')).not.toBeVisible()
}

const DATABASE_URL = process.env.DATABASE_URL?.trim()
let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

/**
 * The hand-off only applies while the company's website is still to do: a
 * website journey left active by another spec in the shared test database
 * would (correctly) turn it off. Start from "not started".
 */
async function websiteNotStarted(): Promise<void> {
  if (!DATABASE_URL) throw new Error('DATABASE_URL not set — the hand-off spec resets the website journey')
  await sql()`update kernel_journeys set status = 'abandoned' where kind = 'website_founding' and status = 'active'`
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
    await stubSpeechSynthesis(context)
    const tts = await interceptTts(context)
    await websiteNotStarted()
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev', profile: 'manual' })

    // The profile step comes first (P-5): first name, last name, picture — then the boot.
    await completeProfileStepInUi(page, { firstName: 'Ada', lastName: 'Lovelace' })
    await expect(page).toHaveURL(/\/(\?|$)/)

    // Boot → greeting, by name. No name ask: the profile step already has it. No capability list, no step counter, no module jargon — ever.
    await expectWizard(page)
    await expect(page.getByText('Step 1 of 5')).not.toBeVisible()
    await expect(page.getByText('Nucleus chat')).not.toBeVisible()
    await expect(page.getByText('Knowledge graph')).not.toBeVisible()
    await expect(page.getByText('Hello, Ada.')).toBeVisible()

    await walkBoot(page, 'Ada')

    // The mind: the one hard gate (no platform provider in this deployment).
    await continueThroughLines(page)
    await expect(page.getByText(MIND_HEADING)).toBeVisible({ timeout: 20_000 })

    // Connect through the server contract (the provider wizard UI is covered by
    // its own component tests + onboarding-provider e2e).
    await saveApiKeyViaApi(page)
    await page.goto('/')

    // The mind gate is gone — the boot finishes in a Begin, straight into the chat.
    await walkBoot(page, null) // name known: no ask
    await continueThroughLines(page)
    await expect(page.getByRole('button', { name: 'Begin' })).toBeVisible({ timeout: 20_000 })
    await page.getByRole('button', { name: 'Begin' }).click()

    // Assisted onboarding: the orchestrator AGENT speaks first (its turn comes
    // from the onboarding context, here the mock gateway's text) — no scripted
    // greeting. It streams into the assistant panel, which opens on its own.
    // The turn goes to the GATEWAY for its voice (the Her layer); the
    // browser's robot voice never speaks.
    await expectHomeVisible(page)
    const panel = page.getByTestId('assistant-panel')
    await expect(panel).toBeVisible({ timeout: 15_000 })
    await expect(panel.getByText(/Hello from mock gateway/i)).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText(/getting set up/)).toHaveCount(0)
    await expect
      .poll(async () => tts.texts.join(' '), { timeout: 15_000 })
      .toMatch(/Hello from mock gateway/i)
    const spokenByRobot = await page.evaluate(
      () => (window as unknown as { __ttsSpoken: string[] }).__ttsSpoken,
    )
    expect(spokenByRobot).toEqual([])

    // Reload: the tour is done — the dashboard is the page now, the greeting
    // stays in the conversation, and it is not sent again.
    await page.goto('/')
    await expectHomeVisible(page)
    await expect(page.getByTestId('assistant-panel')).toHaveCount(0)
    // A click before hydration opens nothing.
    await page.waitForFunction(() => document.body.dataset.eigenHydrated === 'true')
    await page.getByTestId('assistant-toggle').click()
    await expect(
      page.getByTestId('assistant-panel').getByText(/Hello from mock gateway/i),
    ).toHaveCount(1)
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
    await expectHomeVisible(page)

    // The skip decision survives a full sign-out/sign-in cycle (server-side flag).
    await signOut(page)
    await loginUser(page, email)

    await expectHomeVisible(page)
    await expect(page.getByTestId('welcome-wizard')).not.toBeVisible()
  })

  test('restarting onboarding brings the boot back — and it knows your name', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev', profile: { firstName: 'Ada', lastName: 'Lovelace' } })

    // First pass (the name came from the profile step): reach the mind gate, skip it — tour done.
    await walkBoot(page, 'Ada')
    await continueThroughLines(page)
    await expect(page.getByText(MIND_HEADING)).toBeVisible({ timeout: 20_000 })
    await page.getByTestId('skip-onboarding').click()

    // No provider yet: the hard gate takes over. Connect through the server contract.
    await expect(page.getByText('Connect your AI provider.')).toBeVisible({ timeout: 15_000 })
    await saveApiKeyViaApi(page)
    await page.goto('/')
    await expectHomeVisible(page)

    // The cog is in the shell; restart brings the boot sequence back.
    // A click that lands before hydration opens nothing: retry until the menu is up.
    await expect(async () => {
      await page.getByTestId('home-settings-trigger').click()
      await expect(page.getByTestId('restart-onboarding')).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 20_000 })
    await page.getByTestId('restart-onboarding').click()
    await expectWizard(page)

    // Personalized greeting, no name ask — the name survived the restart.
    await expect(page.getByText('Hello, Ada.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Your name' })).not.toBeVisible()

    // And the boot still completes into the app.
    await page.getByTestId('skip-onboarding').click()
    await expectHomeVisible(page)
  })
})
