import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * Phase-cohesion C2 proof: one shell. As an admin, click every navigation
 * entry and every settings section; each lands inside the shell with exactly
 * one highlighted entry and a "<Page> · <Section> · eigenEnterprise" title.
 * The company badge is the way to the dashboard at /; the assistant is the
 * top bar on every page, not a nav entry (polish P-1/P-2).
 * Removed URLs 404 inside the shell with the way back to the dashboard.
 * Screenshots go to SHELL_WALK_SHOTS (default test-results/shell-walk).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the walk promotes its user in the dev DB')

const SHOTS = process.env.SHELL_WALK_SHOTS ?? 'test-results/shell-walk'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

async function newAdmin(context: BrowserContext, page: Page): Promise<void> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const updated = await sql()`update "user" set role = 'admin' where email = ${email} returning id`
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

const sidebar = (page: Page) => page.getByTestId('shell-sidebar')

/** `current` = the one highlighted sidebar entry (a nav id or 'company-link'), or null for none. */
async function expectInShell(page: Page, current: string | null, title: RegExp): Promise<void> {
  await expect(page.getByTestId('app-shell')).toBeVisible()
  // The assistant's top bar is on every signed-in page.
  await expect(page.getByTestId('assistant-bar-input')).toBeVisible()
  await expect(sidebar(page).locator('[aria-current="page"]')).toHaveCount(current ? 1 : 0)
  if (current) {
    const testid = current === 'company-link' ? 'shell-company-link' : `shell-nav-${current}`
    await expect(sidebar(page).getByTestId(testid)).toHaveAttribute('aria-current', 'page')
  }
  await expect(page).toHaveTitle(title)
}

test('every navigation entry and settings section renders inside the one shell', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await newAdmin(context, page)

  // No Assistant, Overview or Agent entry any more (P-1, P-2).
  for (const gone of ['chat', 'overview', 'agent']) {
    await page.goto('/settings')
    await expect(sidebar(page).getByTestId(`shell-nav-${gone}`)).toHaveCount(0)
  }

  const entries: Array<[string, RegExp, RegExp]> = [
    ['messages', /\/messages$/, /^Messages · eigenEnterprise$/],
    ['website', /\/m\/website$/, / · Website · eigenEnterprise$/],
    ['email', /\/m\/email$/, /^Email · eigenEnterprise$/],
    ['brand', /\/brand$/, /^Brand · eigenEnterprise$/],
    ['memory', /\/m\/memory$/, /^Memory · eigenEnterprise$/],
    ['settings', /\/settings$/, /^Account · Settings · eigenEnterprise$/],
  ]
  await page.goto('/settings')
  for (const [id, url, title] of entries) {
    await sidebar(page).getByTestId(`shell-nav-${id}`).click()
    await expect(page).toHaveURL(url)
    await expectInShell(page, id, title)
    await page.screenshot({ path: `${SHOTS}/nav-${id}.png` })
  }
  // The company badge opens the dashboard.
  await sidebar(page).getByTestId('shell-company-link').click()
  await expect(page).toHaveURL(/\/$/)
  await expectInShell(page, 'company-link', /^Dashboard · eigenEnterprise$/)
  await expect(page.getByTestId('dashboard')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/nav-dashboard.png` })

  // The one assistant: ⌘K / Ctrl+K from any page, the panel docks right of the
  // page and stays open with its conversation across client-side navigation.
  await page.goto('/m/website')
  await page.waitForFunction(() => document.body.dataset.eigenHydrated === 'true')
  await page.keyboard.press('ControlOrMeta+k')
  await expect(page.getByTestId('assistant-bar-input')).toBeFocused()
  await page.keyboard.type('What can you do?')
  await page.keyboard.press('Enter')
  const panel = page.getByTestId('assistant-panel')
  await expect(panel).toBeVisible()
  await expect(panel.getByText('What can you do?')).toBeVisible()
  const panelBox = (await panel.boundingBox())!
  const contentBox = (await page.getByTestId('shell-content').boundingBox())!
  expect(panelBox.x).toBeGreaterThanOrEqual(contentBox.x + contentBox.width - 1)
  expect(panelBox.width).toBeGreaterThanOrEqual(320)
  await page.screenshot({ path: `${SHOTS}/assistant-panel.png` })
  await sidebar(page).getByTestId('shell-nav-memory').click()
  await expect(page).toHaveURL(/\/m\/memory$/)
  await expect(panel.getByText('What can you do?')).toBeVisible()
  await page.getByTestId('assistant-close').click()
  await expect(panel).toHaveCount(0)

  const sections: Array<[string, RegExp, string]> = [
    ['members', /\/settings\/members$/, 'Members & invites'],
    ['llm', /\/settings\/llm$/, 'AI provider'],
    ['passkeys', /\/settings\/passkeys$/, 'Passkeys & sessions'],
    ['api-keys', /\/settings\/api-keys$/, 'API keys'],
    ['approvals', /\/settings\/approvals$/, 'Approval mode'],
    ['account', /\/settings$/, 'Account'],
  ]
  await page.goto('/settings')
  for (const [id, url, name] of sections) {
    await page.getByTestId(`settings-nav-${id}`).click()
    await expect(page).toHaveURL(url)
    await expectInShell(page, 'settings', new RegExp(`^${name} · Settings · eigenEnterprise$`))
    await expect(page.getByTestId(`settings-nav-${id}`)).toHaveAttribute('aria-current', 'page')
    await expect(page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible()
    await page.screenshot({ path: `${SHOTS}/settings-${id}.png`, fullPage: true })
  }
  // Passkeys never hang on "Loading…"; the current session is listed.
  await page.goto('/settings/passkeys')
  await expect(page.getByText('Loading…')).toHaveCount(0)
  await expect(page.getByTestId('passkeys-empty')).toBeVisible()
  // A readable device (or when it signed in) — never "Unknown device · Unknown address".
  await expect(page.getByTestId('session-row').first()).not.toContainText('Unknown')
  await expect(page.getByText('this browser')).toBeVisible()
  // No password form anywhere in settings.
  await page.goto('/settings')
  await expect(page.getByText(/password/i).filter({ hasText: 'Change password' })).toHaveCount(0)

  // Kept pages that wait for C3 still render in the shell.
  // The assistant's linkable pages belong to no nav entry: the top bar is their way in.
  const kept: Array<[string, string | null]> = [
    ['/m/memory/notes', 'memory'],
    ['/m/memory/tasks', 'memory'],
    ['/m/memory/projects', 'memory'],
    ['/m/memory/capture', 'memory'],
    ['/assistant', null],
    ['/assistant/activity', null],
    ['/m/website/settings', 'website'],
  ]
  for (const [path, current] of kept) {
    await page.goto(path)
    await expectInShell(page, current, / · eigenEnterprise$/)
    await page.screenshot({ path: `${SHOTS}/kept${path.replaceAll('/', '-')}.png` })
  }

  // Removed URLs 404 inside the shell, with the way back to the dashboard.
  for (const path of [
    '/overview',
    '/agent',
    '/agent/runs',
    '/agent/runs/1',
    '/agent/activity',
    '/agent/roadmap',
    '/graph',
    '/memory',
    '/memory/tasks',
    '/memory/notes',
    '/capture',
    '/chat',
    '/eval',
    '/feedback',
    '/admin/queue',
    '/demo',
    '/register',
    '/api-keys',
    '/settings/agents',
    '/settings/scheduled-tasks',
    '/settings/hosting',
    '/runs',
    '/activity',
    '/settings/extensions',
    '/m/brand',
    '/m/website/hosting',
    '/m/memory/projects/not-a-project',
  ]) {
    const res = await page.goto(path)
    expect(res?.status(), path).toBe(404)
    await expect(page.getByTestId('app-shell')).toBeVisible()
    await expect(page.getByTestId('error-back')).toHaveText('Back to the dashboard')
  }
  await page.screenshot({ path: `${SHOTS}/removed-404.png` })

  // Phone: the drawer carries the same nav.
  await page.setViewportSize({ width: 390, height: 844 })
  await page.goto('/settings/api-keys')
  // A tap before hydration opens nothing.
  await page.waitForFunction(() => document.body.dataset.eigenHydrated === 'true')
  await page.getByTestId('shell-menu-toggle').click()
  await expect(page.getByTestId('shell-drawer').getByTestId('shell-company-link')).toBeVisible()
  await expect(page.getByTestId('shell-drawer').getByTestId('shell-nav-memory')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/phone-drawer.png` })
  await page.getByTestId('shell-drawer').getByTestId('shell-nav-memory').click()
  await expect(page).toHaveURL(/\/m\/memory$/)
  await page.screenshot({ path: `${SHOTS}/phone-memory.png` })
  // Phone: the top bar keeps the assistant; asking opens it as a full-screen sheet.
  await page.getByTestId('assistant-bar-input').fill('Hello')
  await page.getByTestId('assistant-bar-input').press('Enter')
  const sheet = page.getByTestId('assistant-panel')
  await expect(sheet).toBeVisible()
  const box = (await sheet.boundingBox())!
  expect(box.width).toBeGreaterThanOrEqual(389)
  await page.screenshot({ path: `${SHOTS}/phone-assistant.png` })
  await page.getByTestId('assistant-close').click()
  await expect(sheet).toHaveCount(0)
})

test('signed out: unknown pages and dead ends offer Sign in', async ({ page }) => {
  const res = await page.goto('/graph')
  expect(res?.status()).toBe(404)
  await expect(page.getByTestId('error-back')).toHaveText('Sign in')
  await expect(page.getByTestId('app-shell')).toHaveCount(0)
  // The public company site is for visitors: its 404 never offers "Sign in".
  const site404 = await page.goto('/s/no-such-page')
  expect(site404?.status()).toBe(404)
  await expect(page.getByTestId('site-error')).toBeVisible()
  await expect(page.getByRole('link', { name: 'Sign in' })).toHaveCount(0)
  await page.goto('/invite?token=nope')
  await expect(page.getByTestId('invite-sign-in')).toHaveAttribute('href', '/login')
  await page.screenshot({ path: `${SHOTS}/signed-out-invite.png` })
})
