import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * Cohesion C3 (brand-wide): the style the owner chooses in /brand re-skins the
 * WHOLE app, not only /brand/system. Without an active set the shell wears the
 * app's own look (screenshots + computed baseline); choosing Editorial plum
 * turns the sidebar, nav highlight, company badge, headings and body type
 * plum/serif; choosing Swiss red flips it again (red, square, Inter). Brand is
 * a system module: the nav never shows it "Off" and /brand never shows an
 * activation step.
 *
 * Instance-global state: active sets are parked and restored, the owner role is
 * returned, picker-made sets are removed.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the walk promotes its user in the test DB')

const SHOTS = 'test-results/brand-wide'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = (): postgres.Sql => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))

let previousActive: string[] = []
let previousOwnerId: string | null = null
let email = ''

test.beforeAll(async () => {
  const rows = await sql()<{ id: string }[]>`
    UPDATE brand_visual_sets SET status = 'retired' WHERE status = 'active' RETURNING id`
  previousActive = rows.map((r) => r.id)
  const owners = await sql()`select id from "user" where role = 'owner'`
  previousOwnerId = (owners[0]?.id as string | undefined) ?? null
})

test.afterAll(async () => {
  await sql()`delete from brand_visual_sets where picker_node_id is not null`
  for (const id of previousActive) {
    await sql()`UPDATE brand_visual_sets SET status = 'active' WHERE id = ${id}`
  }
  if (email) await sql()`update "user" set role = 'member' where email = ${email}`
  if (previousOwnerId) await sql()`update "user" set role = 'owner' where id = ${previousOwnerId}`
  await _sql?.end()
})

async function newOwner(context: BrowserContext, page: Page): Promise<void> {
  ;({ email } = await registerUser(context, page))
  await sql()`update "user" set role = 'admin' where role = 'owner'`
  const promoted = await sql()`update "user" set role = 'owner' where email = ${email} returning id`
  expect(promoted).toHaveLength(1)
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

type ShellLook = {
  sidebarBg: string
  highlightBg: string
  badgeBg: string
  badgeRadius: string
  bodyFont: string
}

async function shellLook(page: Page): Promise<ShellLook> {
  return page.evaluate(() => {
    const cs = (sel: string) => {
      const el = document.querySelector(sel)
      if (!el) throw new Error(`missing ${sel}`)
      return getComputedStyle(el)
    }
    return {
      sidebarBg: cs('[data-testid="shell-sidebar"]').backgroundColor,
      highlightBg: cs('[data-testid="shell-sidebar"] [aria-current="page"]').backgroundColor,
      badgeBg: cs('[data-testid="shell-company-badge"]').backgroundColor,
      badgeRadius: cs('[data-testid="shell-company-badge"]').borderRadius,
      bodyFont: getComputedStyle(document.body).fontFamily,
    }
  })
}

const headingFont = (page: Page) =>
  page
    .locator('h1')
    .first()
    .evaluate((el) => getComputedStyle(el).fontFamily)

/** Chat, Overview, Settings — returns the Overview look and the Settings heading font. */
async function tour(page: Page, tag: string): Promise<{ look: ShellLook; heading: string }> {
  await page.goto('/')
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/${tag}-chat.png` })
  await page.goto('/overview')
  await expect(page.getByRole('heading', { name: 'Overview', level: 1 })).toBeVisible()
  const look = await shellLook(page)
  await page.screenshot({ path: `${SHOTS}/${tag}-overview.png` })
  await page.goto('/settings')
  await expect(page.locator('h1').first()).toBeVisible()
  const heading = await headingFont(page)
  await page.screenshot({ path: `${SHOTS}/${tag}-settings.png` })
  return { look, heading }
}

async function choose(page: Page, nodeId: string): Promise<void> {
  await page.goto(`/brand?style=${nodeId}`)
  await page.waitForLoadState('networkidle')
  await expect(page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
  await page.getByRole('button', { name: 'Choose this style' }).click()
  await expect(page.getByTestId('chosen-notice')).toBeVisible()
}

test('the chosen style re-skins the whole shell, and a second choice changes it again', async ({
  page,
  context,
}) => {
  test.setTimeout(300_000)
  await page.setViewportSize({ width: 1280, height: 800 })
  await newOwner(context, page)

  // Brand is a system module: listed, never "Off"; /brand opens straight on the picker.
  await page.goto('/overview')
  const brandNav = page.getByTestId('shell-nav-brand')
  await expect(brandNav).toBeVisible()
  await expect(brandNav).not.toContainText('Off')
  await page.goto('/brand')
  await expect(page.getByRole('heading', { name: 'Pick a direction' })).toBeVisible()
  await expect(page.getByText('The branding module is inactive')).toHaveCount(0)

  // ---- no active set: the app's own look ----
  const before = await tour(page, '0-default')
  expect(before.look.sidebarBg).toBe('oklch(0.985 0 0)')
  expect(before.look.badgeBg).toBe('rgb(17, 17, 17)')
  expect(before.look.bodyFont).toMatch(/^Inter,/)
  expect(before.heading).toMatch(/^Inter,/)
  await expect(page.locator('link[data-brand-font]')).toHaveCount(0)

  // ---- Editorial plum: plum chrome, Playfair headings, Source Serif body ----
  await choose(page, 'editorial-classic-plum')
  const plum = await tour(page, '1-plum')
  expect(plum.look.badgeBg).toBe('rgb(91, 42, 110)') // #5b2a6e
  expect(plum.look.sidebarBg).not.toBe(before.look.sidebarBg)
  expect(plum.look.highlightBg).not.toBe(before.look.highlightBg)
  expect(plum.look.badgeRadius).toBe('1.6px') // --radius 0.125rem × 0.8 (rounded-md)
  expect(plum.look.bodyFont).toMatch(/^"Source Serif 4"/)
  expect(plum.heading).toMatch(/^"Playfair Display"/)
  await expect(page.locator('link[data-brand-font="Playfair Display"]')).toHaveCount(1)
  await expect(page.locator('link[data-brand-font="Source Serif 4"]')).toHaveCount(1)
  // The web font actually arrives (Google Fonts reachable from the test box).
  const playfairLoaded = await page.evaluate(async () => {
    await document.fonts.load('32px "Playfair Display"')
    return document.fonts.check('32px "Playfair Display"')
  })
  expect(playfairLoaded).toBe(true)

  await page.setViewportSize({ width: 1280, height: 2400 })
  await page.goto('/brand/system')
  const primary = page
    .locator('[data-testid="system-scope"] button[data-variant="default"]')
    .first()
  await expect(primary).toBeVisible()
  expect(await primary.evaluate((el) => getComputedStyle(el).backgroundColor)).toBe(
    'rgb(91, 42, 110)',
  )
  await page.screenshot({ path: `${SHOTS}/1-plum-brand-system.png` })
  await page.setViewportSize({ width: 1280, height: 800 })

  // ---- Swiss red: a second choice changes everything again ----
  await choose(page, 'swiss-grid-red')
  const red = await tour(page, '2-red')
  expect(red.look.badgeBg).toBe('rgb(200, 16, 46)') // #c8102e
  expect(red.look.sidebarBg).not.toBe(plum.look.sidebarBg)
  expect(red.look.badgeRadius).toBe('0px')
  expect(red.look.bodyFont).toMatch(/^"?Inter"?,/)
  expect(red.heading).toMatch(/^"?Inter"?,/)
  await page.setViewportSize({ width: 1280, height: 2400 })
  await page.goto('/brand/system')
  await page.screenshot({ path: `${SHOTS}/2-red-brand-system.png` })
})
