import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * C3b proof: one page frame. Every area page opens with the same PageHeader
 * (h1, description, optional status pill and actions, tabs below) on the
 * same left edge, and uses the full width of the pane (polish P-3); the
 * signed-out pages share the shell's tokens and the one
 * wordmark. Screenshots go to PAGE_FRAME_SHOTS (default
 * test-results/page-frame) and are meant to be looked at side by side.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the walk promotes its user in the dev DB')

const SHOTS = process.env.PAGE_FRAME_SHOTS ?? 'test-results/page-frame'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newAdmin(context: BrowserContext, page: Page): Promise<void> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const updated = await sql()`
    update "user" set role = 'admin', onboarding_completed = true where email = ${email} returning id`
  if (updated.length !== 1) throw new Error(`could not promote ${email} to admin`)
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

const header = (page: Page) => page.getByTestId('page-header')
const h1Left = async (page: Page) => (await header(page).locator('h1').boundingBox())!.x

test('every area page wears the one page header', async ({ page, context }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await newAdmin(context, page)

  // [path, h1, tabs testid or null]
  // Messages is a full-bleed app layout (Slack-style, P-5 stream): its own h1, no page header.
  await page.goto('/messages')
  await expect(page.getByRole('heading', { level: 1, name: 'Messages' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)

  const areas: Array<[string, string | RegExp, string | null]> = [
    ['/', /^Welcome back/, null],
    ['/m/website', 'Website', 'website-nav'],
    ['/m/email', 'Email', null],
    ['/brand', 'Brand', 'brand-nav'],
    ['/assistant', 'Assistant', 'assistant-area-nav'],
    ['/m/memory', 'Memory', 'memory-nav'],
    ['/settings', 'Settings', 'settings-nav'],
  ]
  const lefts: Record<string, number> = {}
  for (const [path, title, nav] of areas) {
    await page.goto(path)
    await expect(header(page).getByRole('heading', { level: 1, name: title })).toBeVisible()
    await expect(page.getByRole('heading', { level: 1 })).toHaveCount(1)
    await expect(header(page).getByTestId('page-description')).toBeVisible()
    if (nav) {
      // Tabs sit BELOW the title, exactly one current.
      const tabs = page.getByTestId(nav)
      await expect(tabs.locator('[aria-current="page"]')).toHaveCount(1)
      const titleBox = (await header(page).locator('h1').boundingBox())!
      const navBox = (await tabs.boundingBox())!
      expect(navBox.y).toBeGreaterThan(titleBox.y + titleBox.height)
    }
    lefts[path] = await h1Left(page)
    await page.screenshot({ path: `${SHOTS}/area${path === '/' ? '-dashboard' : path.replaceAll('/', '-')}.png` })
  }
  // One left edge for every framed page.
  const edge = lefts['/']
  for (const path of ['/m/website', '/m/email', '/brand', '/assistant', '/m/memory', '/settings'])
    expect(Math.abs(lefts[path] - edge), path).toBeLessThan(2)

  // Full width (P-3): the frame fills the content pane — no centred max-w column.
  for (const path of ['/', '/m/email', '/assistant', '/m/memory', '/settings']) {
    await page.goto(path)
    const frame = page.locator('[data-page-frame]').first()
    const pane = (await page.getByTestId('shell-content').boundingBox())!
    const box = (await frame.boundingBox())!
    expect(Math.abs(box.width - pane.width), path).toBeLessThan(2)
  }

  // Status pills: one style with a dot, on modules.
  for (const path of ['/m/website', '/m/email', '/m/memory']) {
    await page.goto(path)
    await expect(page.getByTestId('module-status')).toHaveText(/Active/)
    await expect(page.getByTestId('module-status').locator('span[aria-hidden="true"]')).toHaveCount(
      1,
    )
  }

  // Website: tabs, no breadcrumb, the primary Add uses the primary token.
  await page.goto('/m/website')
  await expect(page.getByRole('navigation', { name: 'breadcrumb' })).toHaveCount(0)
  await expect(page.getByTestId('add-app')).toHaveAttribute('data-slot', 'button')
  await page.getByTestId('website-tab-settings').click()
  await expect(page).toHaveURL(/\/m\/website\/settings$/)
  await expect(page.getByRole('link', { name: 'Back to repositories' })).toHaveCount(0)
  await page.getByTestId('website-tab-site').click()
  await expect(page).toHaveURL(/\/m\/website\/site$/)
  await page.screenshot({ path: `${SHOTS}/website-site.png` })

  // Plain words for the owner.
  await page.goto('/')
  await expect(page.locator('body')).not.toContainText(/kernel|GTD|hybrid retrieval/)
  await expect(page.getByTestId('overview-modules-hint')).not.toContainText('available')
  // Email (P-6): the developer recipe is its own API tab, not on the Overview.
  await page.goto('/m/email')
  await expect(page.getByTestId('email-tab-api')).toBeVisible()
  await expect(page.getByText('How to send mail')).not.toBeVisible()
  await page.screenshot({ path: `${SHOTS}/email.png`, fullPage: true })
  await page.goto('/settings/llm')
  await expect(page.locator('body')).not.toContainText(
    /entity extraction|capture enrichment|Model Configuration|LLM providers/,
  )
  await page.screenshot({ path: `${SHOTS}/settings-llm.png`, fullPage: true })
  await page.goto('/settings/passkeys')
  await expect(page.getByTestId('session-row').first()).not.toContainText('Unknown')
  await page.screenshot({ path: `${SHOTS}/settings-passkeys.png` })
  await page.goto('/m/memory/tasks')
  await page.screenshot({ path: `${SHOTS}/memory-tasks.png` })

  // A malformed brand-set id is a plain 404, not the validator's text.
  const bad = await page.goto('/brand/editor/x')
  expect(bad?.status()).toBe(404)
  await expect(page.locator('body')).not.toContainText('setId must be a uuid')
})

test('signed-out pages share the shell language and the one wordmark', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 })
  for (const [path, h1] of [
    ['/login', 'Sign in'],
    ['/signup', 'Create an account'],
    ['/claim', 'Claim your company'],
    ['/invite', 'Join your company'],
  ] as const) {
    await page.goto(path)
    await expect(page.getByRole('heading', { level: 1, name: h1 })).toBeVisible()
    await expect(page.getByTestId('wordmark')).toHaveText('eigenEnterprise')
    await expect(page.locator('body')).not.toContainText('Eigen Enterprise')
    // The shell's tokens (white default or the brand style), never the old sage-grey #e8ede5.
    const bg = await page
      .getByTestId('public-surface')
      .evaluate((el) => getComputedStyle(el).backgroundColor)
    expect(bg).not.toBe('rgb(232, 237, 229)')
    await page.screenshot({ path: `${SHOTS}/signed-out${path.replaceAll('/', '-')}.png` })
  }
  // Login and signup both offer the way back home.
  for (const path of ['/login', '/signup']) {
    await page.goto(path)
    await expect(page.getByTestId('back-home')).toBeVisible()
  }
  const missing = await page.goto('/no-such-page')
  expect(missing?.status()).toBe(404)
  await expect(page.getByTestId('wordmark')).toHaveText('eigenEnterprise')
  await page.screenshot({ path: `${SHOTS}/signed-out-404.png` })

  await page.goto('/s')
  await expect(page).not.toHaveTitle(/^Website$/)
  await page.screenshot({ path: `${SHOTS}/signed-out-s.png` })
  const site404 = await page.goto('/s/no-such-page')
  expect(site404?.status()).toBe(404)
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
  await page.screenshot({ path: `${SHOTS}/signed-out-s-404.png` })
})
