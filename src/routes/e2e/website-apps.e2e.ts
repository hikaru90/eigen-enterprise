import { expect, test, type Page, type BrowserContext } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * The Website module's Apps cut (plan/phase-website-apps-ux.md, W7), driven in
 * a real browser against the real dev DB:
 *
 *  1. /m/website/apps — the grid opens with the company site card, closes with
 *     the "+" card; the dialog offers exactly the three ways to add; "Connect
 *     a repo" walks into the three-step flow.
 *  2. /m/website/apps/new — a non-GitHub link comes back as a plain sentence.
 *  3. /m/website/hosting — the light module shell holds even when the stored
 *     theme preference is dark (the reason the page left /settings), and the
 *     old tabs (GitHub, App secrets, Recent activity) are gone.
 *  4. /m/website/site — pages card plus the not-managed domain card.
 *  5. /settings/hosting — lands on /m/website/hosting (the 307).
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
  test('the grid opens with the company site, closes with "+", and the dialog offers three ways to add', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.goto('/m/website/apps')

    // ee is not there: the explicit not-managed state, not an error.
    await expect(page.getByTestId('apps-unmanaged')).toBeVisible()

    const grid = page.locator('section[aria-label="Apps"]')
    await expect(grid).toBeVisible()
    const rows = grid.locator(':scope > *')
    // First card: the company site (D-W1) — it is a card like any app.
    await expect(rows.first().getByTestId('app-card-link')).toHaveText('Company site')
    // Last card: the "+" entry, after every app card.
    await expect(rows.last()).toHaveAttribute('data-testid', 'add-app')

    // The old inline "Deploy a repo" section is gone from the overview.
    await expect(page.getByRole('button', { name: /deploy a repo/i })).toHaveCount(0)

    await page.getByTestId('add-app').click()
    const dialog = page.getByRole('dialog', { name: 'Add an app' })
    await expect(dialog).toBeVisible()
    const options = dialog.getByTestId('add-app-option')
    await expect(options).toHaveCount(3)
    await expect(options.filter({ hasText: 'Build it with chat' })).toBeVisible()
    await expect(options.filter({ hasText: 'Connect a repo' })).toBeVisible()
    await expect(options.filter({ hasText: 'Static site' })).toBeVisible()

    await options.filter({ hasText: 'Connect a repo' }).click()
    await expect(page).toHaveURL(/\/m\/website\/apps\/new$/)
    await expect(page.getByTestId('step-repository')).toBeVisible()
    await expect(page.getByTestId('not-managed')).toBeVisible()
  })

  test('a non-GitHub link comes back as one plain sentence, never a stack', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.goto('/m/website/apps/new')
    await expect(page.getByTestId('step-repository')).toBeVisible()

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

  test('hosting renders in the light module shell even under the dark preference', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.addInitScript(() => localStorage.setItem('theme-preference', 'dark'))
    await page.goto('/m/website/hosting')

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

  test('the site page shows its pages card and the domain card says why it is read-only', async ({
    page,
    context,
  }) => {
    await newOwner(context, page)
    await page.goto('/m/website/site')

    const pages = page.getByTestId('site-pages')
    await expect(pages).toBeVisible()
    // The empty state or existing rows — never an error page.
    const hasEmptyState = (await pages.getByText(/No pages yet/).count()) > 0
    const hasRows = (await pages.getByRole('row').count()) > 0
    expect(hasEmptyState || hasRows).toBe(true)

    await expect(page.getByTestId('site-domain').getByTestId('site-unmanaged')).toBeVisible()
  })

  test('/settings/hosting lands on /m/website/hosting', async ({ page, context }) => {
    await newOwner(context, page)
    await page.goto('/settings/hosting')
    await expect(page).toHaveURL(/\/m\/website\/hosting$/)
    await expect(page.getByRole('heading', { name: 'Hosting', level: 1 })).toBeVisible()
  })

  test('/?prefill= fills the chat draft and nothing is sent', async ({ page, context }) => {
    await newOwner(context, page)
    await connectProvider(page)

    await page.goto('/?prefill=hello')
    const composer = page.getByPlaceholder('What do you need?')
    await expect(composer).toHaveValue('hello')
    // The draft waits for the owner: no conversation, no running turn.
    await expect(page.getByRole('log', { name: 'Conversation' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Stop' })).toHaveCount(0)
  })
})
