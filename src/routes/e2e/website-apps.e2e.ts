import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * The Website module's Apps cut, driven in a real browser against the real
 * dev DB:
 *
 *  1. /m/website — the module front page: apps grid with the activity rail;
 *     /m/website/apps redirects here; the dialog offers exactly the two ways
 *     to add; "Connect a repo" walks into the three-step flow.
 *  2. /m/website/apps/new — a non-GitHub link comes back as a plain sentence.
 *  3. /m/website/settings — the light module shell holds even when the stored
 *     theme preference is dark (the reason the page left /settings), and the
 *     old tabs (GitHub, App secrets, Recent activity) are gone.
 *  4. /m/website/site — the domain card says why it is read-only; the pages
 *     card is gone (pages dropped from the surface).
 *  5. /settings/hosting and /m/website/hosting — removed, 404.
 *  6. /?prefill= — the chat composer carries the draft; nothing is sent.
 *
 * No ee runs locally, so every page is in its explicit not-managed state —
 * that state is asserted, never skipped.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()

test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey promotes its users in the dev DB')

/** Lazy handle; playwright.config loads .env, so this is the DB the dev server uses. */
let _sql: postgres.Sql | null = null
function sql(): postgres.Sql {
  _sql ??= postgres(DATABASE_URL!, { prepare: false })
  return _sql
}

test.afterAll(async () => {
  await _sql?.end()
})

const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

/** Point the account at the mock gateway so `/` shows the chat, not the provider gate. */
async function connectProvider(page: Page): Promise<void> {
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

/**
 * /m/website/* is admin-only. A fresh signup lands as 'member', so the journey
 * promotes its own new harness account to 'admin' (SQL on the dev DB; 'admin'
 * on purpose — the single-owner unique index would fight existing rows). If
 * DATABASE_URL named another database than the server's, the pages would 403
 * and the journey fails loudly instead of passing without coverage.
 */
async function newOwner(context: BrowserContext, page: Page): Promise<void> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const updated = await sql()`update "user" set role = 'admin' where email = ${email} returning id`
  if (updated.length !== 1) throw new Error(`could not promote ${email} to admin`)
}

test.describe('website apps (the module cut, no ee attached)', () => {
  test('the module front page: apps grid + activity rail; the old /apps alias is gone; the dialog offers two ways to add', async ({
    page,
    context,
  }) => {
    const browserErrors: string[] = []
    page.on('pageerror', (error) => browserErrors.push(error.message))
    await newOwner(context, page)
    // The /m/website/apps alias was removed (phase-cohesion C4): 404 in the shell.
    expect((await page.goto('/m/website/apps'))?.status()).toBe(404)
    await page.goto('/m/website')

    // The overview exposes capability without an alarming, blocking deployment banner.
    await expect(page.getByTestId('deployment-server-status')).toBeVisible()
    await expect(page.getByText('Deploys are off on this stack')).toHaveCount(0)
    await expect(
      page.getByTestId('shell-content').getByRole('link', { name: 'Settings', exact: true }),
    ).toBeVisible()

    const grid = page.locator('section[aria-label="Apps and repositories"]')
    await expect(grid).toBeVisible()
    // Apps only — the company site card is gone (pages dropped, D-W7). (The header's
    // one-line description mentions the company site; the grid holds no card for it.)
    await expect(grid.getByText('Company site')).toHaveCount(0)
    // Add stays visible in the header even when there are no repositories yet.
    await expect(page.getByTestId('add-app')).toHaveAccessibleName('Add')

    // The module's recent activity sits in the right rail.
    await expect(page.locator('section[aria-label="Recent activity"]')).toBeVisible()

    await page.waitForFunction(() => document.body.dataset.eigenHydrated === 'true')
    await page.getByTestId('add-app').click()
    const dialog = page.getByRole('dialog', { name: 'Add an app' })
    await expect(dialog).toBeVisible()
    const options = dialog.getByTestId('add-app-option')
    await expect(options).toHaveCount(2)
    await expect(options.filter({ hasText: 'Build it with chat' })).toBeVisible()
    await expect(options.filter({ hasText: 'Connect a repo' })).toBeVisible()
    // Static sites are built with the agent in chat, not a third path.
    await expect(options.filter({ hasText: 'Static site' })).toHaveCount(0)

    await options.filter({ hasText: 'Connect a repo' }).click()
    await expect(page).toHaveURL(/\/m\/website\/apps\/new$/)
    await expect(page.getByTestId('step-repository')).toBeVisible()
    await expect(
      page.getByRole('heading', { name: 'Connect a GitHub repository', level: 2 }),
    ).toBeVisible()
    // Both client navigation and a fresh SSR hydration must use the same runtime.
    await page.reload()
    await expect(page.getByTestId('step-repository')).toBeVisible()
    await page.getByRole('radio', { name: 'Private repository', exact: true }).click()
    await expect(page.getByTestId('check-link')).toBeDisabled()
    await page.getByRole('radio', { name: 'Public repository', exact: true }).click()
    await expect(page.getByTestId('check-link')).toBeEnabled()
    expect(browserErrors).toEqual([])
  })

  test('a connected repository appears before its first deployment and opens its saved branch', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    const repoName = `e2e-source/repo-${Date.now()}`
    const branch = 'preview/features'
    await sql()`insert into github_connected_repos
      (repo_id, branch, full_name, html_url, clone_url, visibility, auth_kind, connected_by)
      values (${Date.now()}, ${branch}, ${repoName}, ${`https://github.com/${repoName}`},
        ${`https://github.com/${repoName}.git`}, 'public', 'public', 'e2e:website-apps')`
    try {
      await page.goto('/m/website')
      const source = page.getByTestId('app-card').filter({ hasText: repoName }).first()
      await expect(source).toBeVisible()
      await expect(source).toContainText(branch)
      await page.screenshot({ path: 'test-results/website-overview.png', fullPage: true })
      await source.getByTestId('app-card-link').click()
      await expect(page).toHaveURL(/\/m\/website\/apps\/new\?/)
      const url = new URL(page.url())
      expect(url.searchParams.get('repo')).toBe(repoName)
      expect(url.searchParams.get('branch')).toBe(branch)
      await expect(page.getByTestId('step-app')).toBeVisible()
    } finally {
      await sql()`delete from github_connected_repos where full_name = ${repoName}`
    }
  })

  test('a non-GitHub link comes back as one plain sentence, never a stack', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.goto('/m/website/apps/new')
    await expect(page.getByTestId('step-repository')).toBeVisible()
    // Wait for hydration: the form must submit through enhance, not natively
    // (a native POST would reload and swallow the plain sentence).
    await page.waitForLoadState('networkidle')

    await page.getByLabel('Repository link').fill('https://example.com/owner/repo')
    await page.getByTestId('check-link').click()

    const error = page.getByTestId('step-error')
    await expect(error).toBeVisible()
    const text = ((await error.textContent()) ?? '').trim()
    expect(text).toMatch(/github\.com/i)
    expect(text).not.toMatch(/at\s+\S+\s*\(|\bError:/)
    // Still on step 1: nothing was connected.
    await expect(page.getByTestId('step-repository')).toBeVisible()
  })

  test('website settings render in the light module shell even under the dark preference', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.addInitScript(() => localStorage.setItem('theme-preference', 'dark'))
    await page.goto('/m/website/settings')

    // The dark preference is really applied to the document...
    expect(await page.evaluate(() => document.documentElement.classList.contains('dark'))).toBe(
      true,
    )
    // ...and the module wrapper still pins its subtree to the white palette.
    const shell = page.locator('.marketing-light-theme')
    await expect(shell).toBeVisible()
    expect(await shell.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
      'rgb(255, 255, 255)',
    )

    // No ee: the explicit not-managed alert instead of a broken-looking page.
    await expect(page.getByTestId('hosting-unmanaged')).toBeVisible()
    // The old hosting tabs moved out: GitHub, App secrets, Recent activity.
    await expect(page.getByRole('heading', { name: 'GitHub' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'App secrets' })).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Recent activity' })).toHaveCount(0)
  })

  test('the site page shows only the domain card — the pages card is gone', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.goto('/m/website/site')

    await expect(page.getByTestId('site-pages')).toHaveCount(0)
    await expect(page.getByRole('heading', { name: 'Pages' })).toHaveCount(0)

    await expect(page.getByTestId('site-domain').getByTestId('site-unmanaged')).toBeVisible()
  })

  test('website settings groups server, domain routing and HTTPS controls', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.goto('/m/website')
    await page
      .getByTestId('shell-content')
      .getByRole('link', { name: 'Settings', exact: true })
      .click()
    await expect(page).toHaveURL(/\/m\/website\/settings$/)
    await expect(page.getByRole('heading', { name: 'Settings', level: 2 })).toBeVisible()
    await expect(page.getByText(/HTTPS/).first()).toBeVisible()
    await expect(page.getByText('Deploys are off on this stack')).toHaveCount(0)
    // Domain routing is a section of this page; the company domain is one link away
    // (the old underlined in-page link row is replaced by the Website tabs).
    await expect(page.getByText('Domains & routing', { exact: true }).first()).toBeVisible()
    await expect(
      page.getByRole('link', { name: 'company site settings', exact: true }).first(),
    ).toHaveAttribute('href', '/m/website/site')
    await page.screenshot({ path: 'test-results/website-settings.png', fullPage: true })
    await page.setViewportSize({ width: 390, height: 844 })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
  })

  test('the legacy /settings/hosting and duplicate /m/website/hosting URLs are gone (404)', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    expect((await page.goto('/settings/hosting'))?.status()).toBe(404)
    expect((await page.goto('/m/website/hosting'))?.status()).toBe(404)
  })

  test('Build it with chat opens an unsent draft from Add', async ({ page, context }) => {
    await newOwner(context, page)
    await page.goto('/m/website')
    await connectProvider(page)
    // Add lives in the Website page header (C3b); a click before hydration is a no-op.
    await page.waitForFunction(() => document.body.dataset.eigenHydrated === 'true')
    await page.getByTestId('add-app').click()
    await page
      .getByRole('dialog', { name: 'Add an app' })
      .getByRole('link', { name: /Build it with chat/ })
      .click()
    const composer = page.getByPlaceholder('What do you need?')
    await expect(composer).toHaveValue('Build me an app: ')
    // The draft waits for the owner: no conversation, no running turn.
    await expect(page.getByRole('log', { name: 'Conversation' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  })
})
