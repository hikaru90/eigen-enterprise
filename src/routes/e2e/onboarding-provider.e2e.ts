import { expect, test, type Page } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * Phase-2a/2b: provider onboarding is two questions (method → provider), catalog-driven,
 * with subscription sign-ins (Claude, ChatGPT, Copilot) and explicit model selection.
 *
 * These tests drive the SERVER CONTRACT through the session-shared request context
 * (deterministic — no UI typing races) and assert the gate on the nucleus surface:
 * a user without a working provider gets the wizard; a connected user gets chat.
 * The wizard UI itself is covered by component tests.
 *
 * All external provider calls resolve against scripts/mock-gateway.mjs via env overrides.
 */

// Must match the mock gateway port playwright's webServer starts (playwright.config.ts).
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

async function expectChatVisible(page: Page): Promise<void> {
  await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })
  await expect(page.getByText('Connect your AI provider.')).not.toBeVisible()
}

async function expectWizardVisible(page: Page): Promise<void> {
  await expect(page.getByText('Connect your AI provider.')).toBeVisible({ timeout: 15_000 })
}

async function postJson(page: Page, path: string, data: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await page.request.post(path, { data })
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>
  return { status: res.status(), body }
}

const CHAT_MODEL = 'mock-chat-model'
const EMBED_MODEL = 'mock-embed-model'

/** Phase-1e: the welcome tour gates `/` for production users — finish it via the API
 * when the test's subject is the provider wizard, not the tour. */
async function completeWelcomeViaApi(page: Page): Promise<void> {
  const done = await postJson(page, '/api/onboarding/welcome', {})
  expect(done.status).toBe(200)
  expect(done.body.ok).toBe(true)
  // The open page rendered before the flag flipped — reload so the load re-runs.
  await page.goto('/')
}

async function saveApiKeyViaApi(page: Page, provider = 'openrouter'): Promise<void> {
  const test = await postJson(page, '/api/onboarding/test-provider', {
    provider,
    baseUrl: GATEWAY_BASE_URL,
    apiKey: `e2e-key-${Date.now()}`,
    modelChat: CHAT_MODEL,
    modelEmbedding: EMBED_MODEL,
  })
  expect(test.status).toBe(200)
  expect(test.body.ok).toBe(true)

  const saved = await postJson(page, '/api/onboarding/provider', {
    provider,
    baseUrl: GATEWAY_BASE_URL,
    apiKey: `e2e-key-${Date.now()}`,
    modelChat: CHAT_MODEL,
    modelEmbedding: EMBED_MODEL,
  })
  expect(saved.status).toBe(200)
  expect(saved.body.ok).toBe(true)
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
    await completeWelcomeViaApi(page)
    await expectWizardVisible(page)

    // Subscription method → provider → explicit model → device flow, via the server
    // contract (the wizard UI for this flow is covered by component tests).
    const start = await postJson(page, '/api/onboarding/copilot/start', {})
    expect(start.status).toBe(200)
    const { deviceCode, userCode, verificationUri } = start.body as {
      deviceCode: string
      userCode: string
      verificationUri: string
    }
    expect(userCode).toBeTruthy()
    expect(verificationUri).toContain('/login/device')

    const poll1 = await postJson(page, '/api/onboarding/copilot/poll', {
      deviceCode,
      modelChat: 'mock-copilot-chat',
    })
    expect(poll1.body.status).toBe('pending') // not authorized yet

    const poll2 = await postJson(page, '/api/onboarding/copilot/poll', {
      deviceCode,
      modelChat: 'mock-copilot-chat',
    })
    expect(poll2.status).toBe(200)
    expect(poll2.body.status).toBe('connected') // stub authorizes on the second poll

    // Connected: the wizard gate opens — chat, never the wizard.
    await page.goto('/')
    await expectChatVisible(page)
  })

  test('Claude subscription: authorize → connect → chat replies via the Anthropic adapter', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })
    await completeWelcomeViaApi(page)
    await expectWizardVisible(page)

    const authorize = await postJson(page, '/api/onboarding/oauth/anthropic/authorize', {})
    expect(authorize.status).toBe(200)
    const authorizeUrl = String(authorize.body.url)
    expect(authorizeUrl).toContain('/claude/authorize')
    expect(authorizeUrl).toContain('state=')

    // Manual-code pattern: the user pastes the code (or the full redirect URL).
    const connect = await postJson(page, '/api/onboarding/oauth/anthropic/connect', {
      code: 'mock-claude-code',
      modelChat: 'claude-sonnet-4-5',
    })
    expect(connect.status).toBe(200)
    expect(connect.body.ok).toBe(true)

    // Real chat turn through the Anthropic adapter (nucleus chat → agent loop → adapter).
    const chat = await page.request.post('/api/chat', {
      data: { message: 'Say hello to the test.' },
      headers: { accept: 'application/x-ndjson' },
    })
    const body = await chat.text()
    expect(body).toContain('Hello from mock Claude')
  })

  test('ChatGPT subscription: device flow → connect → chat replies via the Codex adapter', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })
    await completeWelcomeViaApi(page)
    await expectWizardVisible(page)

    const start = await postJson(page, '/api/onboarding/oauth/openai/start', {})
    expect(start.status).toBe(200)
    const device = start.body as { deviceAuthId: string; userCode: string }
    expect(device.userCode).toBeTruthy()

    const poll1 = await postJson(page, '/api/onboarding/oauth/openai/poll', {
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      modelChat: 'gpt-5.1-codex',
    })
    expect(poll1.body.status).toBe('pending') // 403 pending on first poll

    const poll2 = await postJson(page, '/api/onboarding/oauth/openai/poll', {
      deviceAuthId: device.deviceAuthId,
      userCode: device.userCode,
      modelChat: 'gpt-5.1-codex',
    })
    expect(poll2.status).toBe(200)
    expect(poll2.body.status).toBe('connected')

    const chat = await page.request.post('/api/chat', {
      data: { message: 'Say hello to the test.' },
      headers: { accept: 'application/x-ndjson' },
    })
    const body = await chat.text()
    expect(body).toContain('Hello from mock Codex')
  })

  test('API-key path: catalog provider test + save, then chat via the gateway', async ({
    page,
    context,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })
    await completeWelcomeViaApi(page)
    await expectWizardVisible(page)

    // Dry-run connection test proves the credentials against the mock gateway.
    const test = await postJson(page, '/api/onboarding/test-provider', {
      provider: 'mockgroq',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: CHAT_MODEL,
      modelEmbedding: EMBED_MODEL,
    })
    expect(test.status).toBe(200)
    expect(test.body.ok).toBe(true)

    const saved = await postJson(page, '/api/onboarding/provider', {
      provider: 'mockgroq',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: CHAT_MODEL,
      modelEmbedding: EMBED_MODEL,
    })
    expect(saved.status).toBe(200)
    expect(saved.body.ok).toBe(true)

    const chat = await page.request.post('/api/chat', {
      data: { message: 'Say hello to the test.' },
      headers: { accept: 'application/x-ndjson' },
    })
    const body = await chat.text()
    expect(body).toContain('Hello from mock gateway')
  })

  test('once credentials exist the wizard never comes back', async ({ page, context }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })
    await completeWelcomeViaApi(page)

    await saveApiKeyViaApi(page)

    // Tour done + provider works: the chat IS the homepage — on every re-entry.
    await page.goto('/')
    await expectChatVisible(page)
    await page.goto('/')
    await expectChatVisible(page)

    // Settings shows the minimal Eigen Enterprise page — no wizard, no eigen tabs.
    await page.goto('/settings')
    await expect(page.getByTestId('settings-account')).toBeVisible()
    await expect(page.getByTestId('welcome-wizard')).not.toBeVisible()
    await expect(page.getByText('Appearance')).not.toBeVisible()
    await expect(page.getByText('Danger zone')).not.toBeVisible()

    // Back home: still the chat. (The ONE designed way back to the wizard is
    // the homepage settings cog — covered in onboarding-welcome.e2e.ts.)
    await page.goto('/')
    await expectChatVisible(page)
  })
})
