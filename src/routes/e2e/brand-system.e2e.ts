import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * B4 — the design-system view (/brand/system). Seeds an ACTIVE visual set with
 * distinctive tokens straight into the test DB, then proves the app's own
 * shadcn components consume them (computed values, light and dark) and that
 * the page shows its empty state without an active set. The previously active
 * set (if any) is restored afterwards — the visual set is instance-global.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the spec seeds brand_visual_sets in the dev DB')

let _sql: postgres.Sql | null = null
function sql(): postgres.Sql {
  _sql ??= postgres(DATABASE_URL!, { prepare: false })
  return _sql
}

const SHOTS = path.resolve('test-results/brand-system')

const LIGHT = {
  '--background': '#fff8e7',
  '--foreground': '#1a1033',
  '--card': '#fffdf6',
  '--card-foreground': '#1a1033',
  '--popover': '#fffdf6',
  '--popover-foreground': '#1a1033',
  '--primary': '#ff0080',
  '--primary-foreground': '#ffffff',
  '--secondary': '#ffe0f0',
  '--secondary-foreground': '#1a1033',
  '--muted': '#f3ead6',
  '--muted-foreground': '#6b5d80',
  '--accent': '#ffe0f0',
  '--accent-foreground': '#1a1033',
  '--border': '#e6d6b8',
  '--input': '#e6d6b8',
  '--ring': '#ff0080',
  '--radius': '1.5rem',
  '--font-sans': '"Space Grotesk"',
  '--font-display': '"Playfair Display"',
  '--font-mono': '"JetBrains Mono"',
  '--shadow-1': '0 1px 2px rgb(255 0 128 / 0.2)',
  '--shadow-2': '0 4px 10px rgb(255 0 128 / 0.25)',
  '--shadow-3': '0 12px 28px rgb(255 0 128 / 0.3)',
}
const DARK = {
  '--background': '#10141f',
  '--foreground': '#f5f0ff',
  '--card': '#1a2030',
  '--card-foreground': '#f5f0ff',
  '--primary': '#00c8ff',
  '--primary-foreground': '#001018',
  '--muted': '#232a3d',
  '--muted-foreground': '#a6a0c0',
  '--border': '#2e3650',
  '--input': '#2e3650',
}

let previousActive: string[] = []
let seededId: string | null = null

test.describe.configure({ mode: 'serial' })

test.beforeAll(async () => {
  // Park whatever is active so the empty state is reachable; restored in afterAll.
  const rows = await sql()<{ id: string }[]>`
    UPDATE brand_visual_sets SET status = 'retired' WHERE status = 'active' RETURNING id`
  previousActive = rows.map((r) => r.id)
})

test.afterAll(async () => {
  if (seededId) await sql()`DELETE FROM brand_visual_sets WHERE id = ${seededId}`
  for (const id of previousActive) {
    await sql()`UPDATE brand_visual_sets SET status = 'active' WHERE id = ${id}`
  }
  await _sql?.end()
})

async function computed(page: Page, selector: string, prop: string): Promise<string> {
  return page
    .locator(selector)
    .first()
    .evaluate((el, p) => getComputedStyle(el).getPropertyValue(p), prop)
}

test('without an active style the page shows the choose-a-style empty state', async ({
  page,
  context,
}) => {
  await registerUser(context, page)
  await page.goto('/brand/system')
  const empty = page.getByTestId('system-empty')
  await expect(empty.getByRole('heading', { name: 'Choose a style first' })).toBeVisible()
  await expect(empty.getByRole('link', { name: 'Choose a style' })).toHaveAttribute(
    'href',
    /\/brand$/,
  )
  await page.screenshot({ path: `${SHOTS}/empty.png`, fullPage: true })
})

test('signed-out visitors are sent to /login', async ({ page }) => {
  await page.goto('/brand/system')
  await page.waitForURL(/\/login/)
})

test('a member sees every component in the active style, light and dark', async ({
  page,
  context,
}) => {
  const [row] = await sql()<{ id: string }[]>`
    INSERT INTO brand_visual_sets (status, name, css_vars, dark_css_vars)
    VALUES ('active', 'E2E Flamingo', ${sql().json(LIGHT)}, ${sql().json(DARK)})
    RETURNING id`
  seededId = row.id

  await registerUser(context, page) // a plain member — no admin promotion
  // Tall viewport: the shell scrolls its own content column, so a fullPage
  // shot would only capture the first screen of the component set.
  await page.setViewportSize({ width: 1280, height: 3200 })
  await page.goto('/brand/system')
  await expect(page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
  await expect(page.getByText('E2E Flamingo').first()).toBeVisible()

  // The Google Fonts links for the three font roles.
  for (const family of ['Playfair+Display', 'Space+Grotesk', 'JetBrains+Mono']) {
    await expect(page.locator(`link[href*="family=${family}"]`)).toHaveCount(1)
  }

  const scope = page.getByTestId('system-scope')
  const primary = '[data-testid="system-scope"] button[data-variant="default"]'

  // ---- light ----
  await expect(scope).toHaveAttribute('data-system-theme', 'light')
  expect(await computed(page, primary, 'background-color')).toBe('rgb(255, 0, 128)')
  expect(await computed(page, primary, 'color')).toBe('rgb(255, 255, 255)')
  // rounded-md = --radius * 0.8 = 1.2rem = 19.2px; card rounded-lg = --radius = 24px.
  expect(await computed(page, primary, 'border-top-left-radius')).toBe('19.2px')
  expect(
    await computed(
      page,
      '[data-testid="system-scope"] [data-slot="card"]',
      'border-top-left-radius',
    ),
  ).toBe('24px')
  expect(
    await computed(
      page,
      '[data-testid="system-scope"] [data-slot="input"]',
      'border-top-left-radius',
    ),
  ).toBe('19.2px')
  expect(await computed(page, '[data-type-step="h1"]', 'font-family')).toContain('Playfair Display')
  expect(await computed(page, '[data-type-step="body"]', 'font-family')).toContain('Space Grotesk')
  expect(await computed(page, '[data-type-step="mono"]', 'font-family')).toContain('JetBrains Mono')
  expect(await computed(page, '[data-testid="system-scope"]', 'background-color')).toBe(
    'rgb(255, 248, 231)',
  )
  expect(
    await computed(page, '[data-testid="system-scope"] [data-slot="badge"]', 'background-color'),
  ).toBe('rgb(255, 0, 128)')
  expect(await computed(page, '[data-shadow="--shadow-3"] div', 'box-shadow')).toContain(
    'rgba(255, 0, 128, 0.3)',
  )
  // The app shell itself consumes the global :root override too (no light pin).
  expect(
    await page.evaluate(() =>
      getComputedStyle(document.documentElement).getPropertyValue('--primary').trim(),
    ),
  ).toBe('#ff0080')

  await page.evaluate(() => document.fonts.ready)
  const fontsLoaded = await page.evaluate(() => document.fonts.check('32px "Playfair Display"'))
  console.info(`[brand-system] Playfair Display loaded from Google Fonts: ${fontsLoaded}`)
  await page.screenshot({ path: `${SHOTS}/light.png`, fullPage: true })

  // ---- dark (page-scoped) ----
  await page.getByTestId('system-mode-dark').click()
  await expect(scope).toHaveAttribute('data-system-theme', 'dark')
  await expect.poll(() => computed(page, primary, 'background-color')).toBe('rgb(0, 200, 255)')
  expect(await computed(page, '[data-testid="system-scope"]', 'background-color')).toBe(
    'rgb(16, 20, 31)',
  )
  expect(await computed(page, '[data-type-step="h1"]', 'color')).toBe('rgb(245, 240, 255)')
  expect(await computed(page, '[data-type-step="h1"]', 'font-family')).toContain('Playfair Display')
  expect(await computed(page, primary, 'border-top-left-radius')).toBe('19.2px')
  // The page header outside the scope stays on the app theme (switch is page-scoped).
  expect(await computed(page, 'main h1, h1', 'color')).not.toBe('rgb(245, 240, 255)')
  await page.screenshot({ path: `${SHOTS}/dark.png`, fullPage: true })
})
