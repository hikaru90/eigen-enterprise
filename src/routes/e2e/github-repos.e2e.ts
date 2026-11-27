import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { MOCK_GITHUB_LOGIN, MOCK_GITHUB_TOKEN } from '../../../scripts/mock-github-core'
import { completeProfileViaApi, gotoHydrated, profileNames, registerUser } from './test-helpers'

/**
 * GitHub repos copy every file into Drive (plan/github-drive-full-mirror.md
 * §1, §6, §8 M4), against the mock GitHub (scripts/mock-github.ts; the
 * harness reads it through GITHUB_TOKEN_API_BASE_URL / GITHUB_CODELOAD_BASE_URL):
 *
 *  admin → Settings → Plugins: GitHub repos on → Drive → GitHub repos: paste
 *  the fine-grained token, tick kindred/shop, Sync now → Drive: GitHub /
 *  kindred / shop / main / src / index.ts opens as text, assets/logo.png as
 *  an image, Overview.md says "5 files" → copy mode "docs only" (confirmed) →
 *  Sync now → main/src is gone, README.md and docs/guide.md stay.
 *
 * Screenshots go to GITHUB_REPOS_SHOTS (default test-results/github-repos).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its admin in the test DB')

const SHOTS = process.env.GITHUB_REPOS_SHOTS ?? 'test-results/github-repos'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const REPO = 'kindred/shop'

let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

/** A production admin with a complete profile and the mock gateway as AI provider (summaries). */
async function newAdmin(context: BrowserContext, page: Page): Promise<void> {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set role = 'admin', name = 'Ada Admin', account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not prepare ${email}`)
  await completeProfileViaApi(page, profileNames('Ada Admin'))
  const saved = await page.request.post('/api/onboarding/provider', {
    data: { provider: 'openrouter', baseUrl: GATEWAY_BASE_URL, apiKey: `e2e-key-${Date.now()}`, modelChat: 'mock-chat-model', modelEmbedding: 'mock-embed-model' },
  })
  expect(saved.status()).toBe(200)
}

const row = (page: Page, name: string) => page.locator(`[data-testid="drive-row"][data-name="${name}"]`)

/** Opens each named folder (or, last, the file) from the current Drive listing. */
async function openPath(page: Page, names: string[]): Promise<void> {
  for (const name of names) {
    await expect(row(page, name)).toBeVisible()
    const isFolder = (await row(page, name).getAttribute('data-type')) === 'folder'
    await row(page, name).getByTestId('drive-open').click()
    // A folder's path ends in its name; a file page names the file in its header (the path is its folder's).
    if (isFolder) await expect(page.getByTestId('drive-path')).toContainText(name)
    else await expect(page.getByTestId('drive-file')).toContainText(name)
  }
}

/** Drive → the GitHub section of the rail → GitHub / kindred / shop. */
async function openRepoFolder(page: Page): Promise<void> {
  await gotoHydrated(page, '/drive')
  await page.getByTestId('drive-rail').getByRole('link', { name: 'GitHub', exact: true }).click()
  await expect(page).toHaveURL(/\/drive\/folder\//)
  await openPath(page, ['kindred', 'shop'])
}

/** "Last synced …" of the repo's status row (its "next …" moves as soon as Sync now is clicked). */
async function lastSynced(page: Page): Promise<string> {
  const text = (await page.getByTestId(`repos-status-${REPO}`).textContent()) ?? ''
  const m = /Last synced [^·]*/.exec(text)
  if (!m) throw new Error(`no "Last synced" in the status row of ${REPO}: ${text}`)
  return m[0].trim()
}

/**
 * Sync now, and wait until that sync is done. The job-queue tick (every minute) may claim the
 * newly connected repo first: then the page says it is syncing already, and the sync the tick
 * runs is the one waited for — the status row's "Last synced" moves when it is done.
 */
async function syncNow(page: Page): Promise<void> {
  const status = page.getByTestId(`repos-status-${REPO}`)
  await expect(status).toBeVisible()
  const before = await lastSynced(page)
  await status.getByRole('button', { name: 'Sync now' }).click()
  const synced = page.getByRole('status').filter({ hasText: `Synced ${REPO}.` })
  const already = page.getByRole('status').filter({ hasText: `${REPO} is syncing already.` })
  await expect(synced.or(already)).toBeVisible({ timeout: 90_000 })
  if (await synced.isVisible()) return
  await expect
    .poll(
      async () => {
        await gotoHydrated(page, '/drive/github')
        return lastSynced(page)
      },
      { timeout: 90_000, intervals: [2_000] },
    )
    .not.toBe(before)
}

test('GitHub repos: every file of the default branch in Drive, then docs only', async ({ browser }) => {
  // Sign-up, plugin switch, token, two syncs (tarball + blob path) on a cold Vite dev server.
  test.setTimeout(300_000)
  const context = await browser.newContext()
  const page = await context.newPage()
  await newAdmin(context, page)

  // The GitHub repos plugin on (Settings → Plugins, the registry's kernel.module_activate).
  await gotoHydrated(page, '/settings/modules')
  const plugin = page.getByTestId('plugin-repos')
  await expect(plugin).toBeVisible()
  if ((await plugin.getByTestId('plugin-state').textContent())?.trim() !== 'On') {
    await page.getByTestId('plugin-switch-repos').click()
    await expect(plugin.getByTestId('plugin-state')).toHaveText('On')
  }

  // The test DB outlives runs: an earlier run's token of the mock login is removed first (its folders go with it).
  await gotoHydrated(page, '/drive/github')
  await expect(page.getByTestId('repos-header')).toContainText('Active')
  const earlier = page.getByTestId(`repos-token-${MOCK_GITHUB_LOGIN}`)
  if ((await earlier.count()) > 0) {
    page.once('dialog', (d) => void d.accept())
    await earlier.getByRole('button', { name: 'Remove token' }).click()
    await expect(page.getByRole('status').filter({ hasText: 'The token was removed.' })).toBeVisible()
    await expect(earlier).toHaveCount(0)
  }

  // Paste the token, tick the repo.
  const add = page.getByTestId('repos-addToken')
  await add.locator('input[name="token"]').fill(MOCK_GITHUB_TOKEN)
  await add.getByRole('button', { name: 'Check and save' }).click()
  await expect(page.getByRole('status').filter({ hasText: `Connected the token of ${MOCK_GITHUB_LOGIN}.` })).toBeVisible()
  const pick = page.getByTestId(`repos-pick-${REPO}`)
  await expect(pick).not.toBeChecked()
  await pick.check()
  await expect(page.getByTestId(`repos-status-${REPO}`)).toBeVisible()
  await expect(pick).toBeChecked()

  // First sync: the tarball path, every file under main/.
  await syncNow(page)
  await page.screenshot({ path: `${SHOTS}/01-synced.png`, fullPage: true })

  await openRepoFolder(page)
  for (const name of ['Overview.md', 'main']) await expect(row(page, name)).toBeVisible()
  await expect(row(page, 'Docs')).toHaveCount(0)
  const repoFolderUrl = page.url()
  await openPath(page, ['main'])
  for (const name of ['README.md', 'package.json', 'assets', 'docs', 'src']) await expect(row(page, name)).toBeVisible()
  const mainFolderUrl = page.url()
  await page.screenshot({ path: `${SHOTS}/02-main-folder.png`, fullPage: true })

  // Code opens as text, read-only.
  await openPath(page, ['src', 'index.ts'])
  await expect(page).toHaveURL(/\/drive\/file\//)
  await expect(page.getByTestId('drive-text')).toContainText("export const greeting = 'Hello from the Kindred shop'")
  await expect(page.getByTestId('drive-readonly-badge')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/03-index-ts.png`, fullPage: true })

  // The PNG previews as an image (the real 8×6 bytes).
  await gotoHydrated(page, mainFolderUrl)
  await openPath(page, ['assets', 'logo.png'])
  const img = page.getByTestId('drive-image')
  await expect(img).toBeVisible()
  await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth)).toBe(8)
  await page.screenshot({ path: `${SHOTS}/04-logo-png.png`, fullPage: true })

  // Overview says what was copied.
  await gotoHydrated(page, repoFolderUrl)
  await openPath(page, ['Overview.md'])
  await expect(page.getByTestId('drive-markdown')).toContainText('5 files')
  await page.screenshot({ path: `${SHOTS}/05-overview.png`, fullPage: true })

  // Copy mode → docs only (it asks first), then sync: the code goes, the Markdown stays.
  await gotoHydrated(page, '/drive/github')
  const mode = page.getByTestId(`repos-copy-mode-${REPO}`)
  await expect(mode).toHaveValue('all')
  page.once('dialog', (d) => void d.accept())
  await mode.selectOption('docs')
  await expect(page.getByTestId('repos-copy-mode-status')).toBeVisible()
  await expect(mode).toHaveValue('docs')
  await syncNow(page)
  await page.screenshot({ path: `${SHOTS}/06-docs-only-synced.png`, fullPage: true })

  await gotoHydrated(page, mainFolderUrl)
  await expect(row(page, 'README.md')).toBeVisible()
  await expect(row(page, 'docs')).toBeVisible()
  for (const name of ['src', 'assets', 'package.json']) await expect(row(page, name)).toHaveCount(0)
  await openPath(page, ['docs'])
  await expect(row(page, 'guide.md')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/07-docs-only-main.png`, fullPage: true })

  await context.close()
})
