import { expect, test } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * The brand picker (plan/phase-brand-picker.md §3.3), driven in a real browser
 * against the test DB, over the picker fixture (playwright.config.ts sets
 * BRAND_PICKER_INDEX=fixture):
 *
 *  owner → /brand (genres) → genre → style → variant → Choose this style →
 *  the root layout's :root override carries the chosen tokens (--primary) →
 *  browser back/forward + breadcrumb step through the levels → a non-owner
 *  browses but cannot choose (page + endpoint, 403).
 *
 * The company has one owner (user_single_owner): the existing owner is demoted
 * for the run and restored afterwards; created visual sets are removed.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey promotes its user in the test DB')

let _sql: postgres.Sql | null = null
const sql = (): postgres.Sql => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))

const SHOTS = 'test-results/brand-picker'
let previousOwnerId: string | null = null
let previousBrandActive: boolean | null = null
let email = ''

test.beforeAll(async () => {
  const owners = await sql()`select id from "user" where role = 'owner'`
  previousOwnerId = (owners[0]?.id as string | undefined) ?? null
  const act = await sql()`select active from kernel_module_activations where module_id = 'brand'`
  previousBrandActive = (act[0]?.active as boolean | undefined) ?? null
  await sql()`
    insert into kernel_module_activations (module_id, active, updated_at) values ('brand', true, now())
    on conflict (module_id) do update set active = true, updated_at = now()`
})

test.afterAll(async () => {
  await sql()`delete from brand_visual_sets where picker_node_id is not null`
  if (email) await sql()`update "user" set role = 'member' where email = ${email}`
  if (previousOwnerId) await sql()`update "user" set role = 'owner' where id = ${previousOwnerId}`
  if (previousBrandActive === null) await sql()`delete from kernel_module_activations where module_id = 'brand'`
  else await sql()`update kernel_module_activations set active = ${previousBrandActive} where module_id = 'brand'`
  await _sql?.end()
})

test('owner drills genre → style → variant, chooses it, and the app wears the tokens', async ({ page, context }) => {
  // One long journey (sign-up, four levels, two choices, a role flip) on a cold Vite dev server.
  test.setTimeout(240_000)
  ;({ email } = await registerUser(context, page))
  await sql()`update "user" set role = 'admin' where role = 'owner'`
  const promoted = await sql()`update "user" set role = 'owner' where email = ${email} returning id`
  expect(promoted).toHaveLength(1)

  // Level 1 — the genres.
  await page.goto('/brand')
  await expect(page.getByRole('heading', { name: 'Pick a direction' })).toBeVisible()
  await expect(page.locator('a[data-picker-card]')).toHaveCount(2)
  await expect(page.getByTestId('active-style')).toContainText('No style chosen yet')
  await page.screenshot({ path: `${SHOTS}/1-genres.png`, fullPage: true })

  // Level 2 — styles in the genre (the grid is replaced, the URL carries the path).
  await page.locator('a[data-picker-card="swiss-minimal"]').click()
  await expect(page).toHaveURL(/\/brand\?style=swiss-minimal$/)
  await expect(page.getByRole('heading', { name: 'Styles in Swiss minimal' })).toBeVisible()
  await expect(page.locator('a[data-picker-card]')).toHaveCount(2)
  await page.screenshot({ path: `${SHOTS}/2-styles.png`, fullPage: true })

  // Level 3 — variants; the preview switch flips the images to dark.
  await page.locator('a[data-picker-card="swiss-grid"]').click()
  await expect(page.getByRole('heading', { name: 'Variants of International grid' })).toBeVisible()
  const firstImg = page.locator('a[data-picker-card] img').first()
  await expect(firstImg).toHaveAttribute('src', '/brand-previews/fixture/swiss-grid-red-light.svg')
  await page.getByRole('button', { name: 'dark' }).click()
  await expect(firstImg).toHaveAttribute('src', '/brand-previews/fixture/swiss-grid-red-dark.svg')
  await page.screenshot({ path: `${SHOTS}/3-variants-dark.png`, fullPage: true })
  await page.getByRole('button', { name: 'light' }).click()

  // Final level — choose.
  await page.locator('a[data-picker-card="swiss-grid-blue"]').click()
  await expect(page.getByTestId('final-style')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/4-final.png`, fullPage: true })
  await page.getByRole('button', { name: 'Choose this style' }).click()
  await expect(page.getByTestId('chosen-notice')).toBeVisible()
  await expect(page.getByTestId('active-style')).toContainText('Swiss minimal › International grid › Cobalt')

  // The root layout's :root override now carries the chosen tokens.
  const tokens = await page.evaluate(() => {
    const s = getComputedStyle(document.documentElement)
    return {
      dark: document.documentElement.classList.contains('dark'),
      primary: s.getPropertyValue('--primary').trim(),
      radius: s.getPropertyValue('--radius').trim(),
    }
  })
  expect(tokens.primary).toBe(tokens.dark ? '#5b8cff' : '#0047ab')
  expect(tokens.radius).toBe('0rem')
  await page.screenshot({ path: `${SHOTS}/5-chosen.png`, fullPage: true })

  const rows = await sql()`select status, css_vars, dark_css_vars from brand_visual_sets where picker_node_id = 'swiss-grid-blue'`
  expect(rows).toHaveLength(1)
  expect(rows[0]!.status).toBe('active')
  const parse = (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v) as Record<string, string>
  expect(parse(rows[0]!.css_vars)['--primary']).toBe('#0047ab')
  expect(parse(rows[0]!.dark_css_vars)['--primary']).toBe('#5b8cff')

  // Browser back steps up the levels; forward returns; the breadcrumb jumps to the top.
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Variants of International grid' })).toBeVisible()
  await page.goBack()
  await expect(page.getByRole('heading', { name: 'Styles in Swiss minimal' })).toBeVisible()
  await page.goForward()
  await expect(page.getByRole('heading', { name: 'Variants of International grid' })).toBeVisible()
  await page.getByRole('navigation', { name: 'Style path' }).getByRole('link', { name: 'All styles' }).click()
  await expect(page).toHaveURL(/\/brand$/)
  await expect(page.getByRole('heading', { name: 'Pick a direction' })).toBeVisible()

  // Choosing again retires the previous set.
  await page.goto('/brand?style=editorial-modern-amber')
  // A full load (not a client navigation): wait for hydration before clicking.
  await page.waitForLoadState('networkidle')
  await page.getByRole('button', { name: 'Choose this style' }).click()
  await expect(page.getByTestId('chosen-notice')).toBeVisible()
  const statuses = await sql()`select picker_node_id, status from brand_visual_sets where picker_node_id is not null order by created_at`
  expect(statuses.map((r) => `${r.picker_node_id}:${r.status}`)).toEqual([
    'swiss-grid-blue:retired',
    'editorial-modern-amber:active',
  ])
  await page.screenshot({ path: `${SHOTS}/6-rechosen.png`, fullPage: true })

  // A non-owner browses but cannot choose — the page hides the action, the endpoint refuses (fail closed).
  await sql()`update "user" set role = 'admin' where email = ${email}`
  await page.goto('/brand?style=swiss-soft-mint')
  await expect(page.getByText('Only the company owner can choose the style.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Choose this style' })).toHaveCount(0)
  const refused = await page.request.post('/api/brand/picker/choose', { data: { nodeId: 'swiss-soft-mint' } })
  expect(refused.status()).toBe(403)
  await page.screenshot({ path: `${SHOTS}/7-non-owner.png`, fullPage: true })

  // Unknown style ids fail loud.
  const missing = await page.goto('/brand?style=ghost')
  expect(missing?.status()).toBe(404)
})
