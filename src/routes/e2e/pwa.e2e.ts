import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Messages as an installable app: the manifest is public and opens on
 * Messages, a signed-in page gets the service worker, Messages offers to turn
 * notifications on for this device, and the installed app shows an explicit
 * offline page instead of the browser's error when there is no connection.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the test sets roles in the test DB')

const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newMember(context: BrowserContext, page: Page, name: string) {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`
    update "user" set role = 'member', name = ${name}, account_kind = 'production', onboarding_completed = true
    where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not set up ${email}`)
  await completeProfileViaApi(page, profileNames(name))
  const saved = await page.request.post('/api/onboarding/provider', {
    data: {
      provider: 'openrouter',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: 'mock-chat-model',
      modelEmbedding: 'mock-embed-model',
    },
  })
  expect(saved.status()).toBe(200)
}

test('installable Messages: manifest, service worker, notifications banner, offline page', async ({ browser }) => {
  test.setTimeout(120_000)
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, permissions: ['notifications'] })
  const page = await context.newPage()

  // Public: the browser fetches it before anyone signs in.
  const manifest = await page.request.get('/manifest.webmanifest')
  expect(manifest.status()).toBe(200)
  expect(manifest.headers()['content-type']).toContain('application/manifest+json')
  expect(await manifest.json()).toMatchObject({ display: 'standalone', start_url: '/messages' })
  for (const src of ['/pwa-192.png', '/pwa-512.png', '/pwa-512-maskable.png']) {
    expect((await page.request.get(src)).status()).toBe(200)
  }

  await newMember(context, page, `Pia ${Date.now().toString(36)}`)
  await page.goto('/messages')
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute('href', '/manifest.webmanifest')
  await expect(page.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')

  const scriptURL = await page.evaluate(async () => (await navigator.serviceWorker.ready).active?.scriptURL)
  expect(scriptURL).toMatch(/\/service-worker\.js$/)

  // The banner follows the browser's real permission (headless Chromium may
  // report "denied" even when granted); the mapping itself is unit-tested.
  const permission = await page.evaluate(() => Notification.permission)
  await expect(page.getByTestId('push-banner')).toHaveAttribute('data-state', permission === 'denied' ? 'denied' : 'ask')
  await page.getByTestId('push-banner-dismiss').click()
  await expect(page.getByTestId('push-banner')).toHaveCount(0)
  await page.reload()
  await expect(page.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await expect(page.getByTestId('push-banner')).toHaveCount(0)

  // The page is now controlled by the worker: offline, a page load says so.
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null)
  await context.setOffline(true)
  await page.goto('/messages').catch(() => {})
  await expect(page.getByRole('heading', { name: "You're offline" })).toBeVisible()
  await context.setOffline(false)
  await page.getByRole('button', { name: 'Try again' }).click()
  await expect(page.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')

  await context.close()
})
