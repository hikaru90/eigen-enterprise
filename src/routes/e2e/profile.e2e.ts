import { expect, test, type BrowserContext, type Page } from '@playwright/test'
import postgres from 'postgres'
import { completeProfileStepInUi, completeProfileViaApi, pngBytes, registerUser } from './test-helpers'

/**
 * P-5 proof (plan/phase-polish-1.md): a person who signs in without a
 * complete profile is sent to /welcome/profile before any page of the app —
 * the server redirects, whatever they open — picks a picture (cropped square
 * in the browser, saved as a 256 px WebP), gives first and last name, and
 * continues. Messages then shows their name and picture to everyone; Settings ›
 * Account edits the same profile. Screenshots: PROFILE_SHOTS (default test-results/profile).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the test prepares its second member in the test DB')

const SHOTS = process.env.PROFILE_SHOTS ?? 'test-results/profile'
let _sql: postgres.Sql | null = null
const sql = () => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
test.afterAll(async () => {
  await _sql?.end()
})

/** A second production member with a complete profile (set up through the API). */
async function member(context: BrowserContext, page: Page, first: string, last: string) {
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const rows = await sql()`update "user" set account_kind = 'production', onboarding_completed = true where email = ${email} returning id`
  if (rows.length !== 1) throw new Error(`could not prepare ${email}`)
  await completeProfileViaApi(page, { firstName: first, lastName: last })
  return { email }
}

const loadedWidth = (img: import('@playwright/test').Locator) => img.evaluate((el: HTMLImageElement) => el.naturalWidth)

test('sign in → the profile step first → picture + names → Messages shows them', async ({ browser }) => {
  test.setTimeout(180_000)
  const suffix = Date.now().toString(36)
  const channel = `hello-${suffix}`
  const last = `Profile${suffix}`

  // ── A signs up with a real address: production account, no profile yet ──
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const a = await ctxA.newPage()
  const { email } = await registerUser(ctxA, a, { emailDomain: 'kindred-e2e.example', profile: 'manual' })
  await expect(a).toHaveURL(/\/welcome\/profile\?next=%2F$/)
  await expect(a.getByRole('heading', { level: 1 })).toHaveText('Set up your profile')
  await a.screenshot({ path: `${SHOTS}/01-profile-step.png`, fullPage: true })

  // The gate is the server's: any shell page sends A back here, remembering where A was going.
  await a.goto('/messages?c=x')
  await expect(a).toHaveURL(/\/welcome\/profile\?next=%2Fmessages%3Fc%3Dx$/)
  await a.goto('/settings')
  await expect(a).toHaveURL(/\/welcome\/profile\?next=%2Fsettings$/)
  // The upload API takes only the editor's square WebP.
  const png = await a.request.post('/api/profile/avatar', { headers: { 'content-type': 'image/png' }, data: pngBytes(64, 64) })
  expect(png.status()).toBe(415)
  const pretend = await a.request.post('/api/profile/avatar', { headers: { 'content-type': 'image/webp' }, data: pngBytes(64, 64) })
  expect(pretend.status()).toBe(400)

  // A picks a picture, crops it, names themselves, continues → back where they were going.
  await a.goto('/welcome/profile?next=%2Fmessages')
  await a.getByTestId('profile-picture-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: pngBytes(320, 200) })
  await expect(a.getByTestId('profile-crop')).toBeVisible()
  await a.screenshot({ path: `${SHOTS}/02-crop.png`, fullPage: true })
  await completeProfileStepInUi(a, { firstName: 'Pia', lastName: last })
  await expect(a).toHaveURL(/\/messages$/)

  const [row] = await sql()`select name, first_name, last_name, avatar_sha256, image from "user" where email = ${email}`
  expect(row).toMatchObject({ name: `Pia ${last}`, first_name: 'Pia', last_name: last })
  expect(row!.avatar_sha256).toMatch(/^[0-9a-f]{64}$/)
  expect(row!.image).toBe(`/api/people/avatar/${row!.avatar_sha256}`)

  // The picture is a 256 px WebP, for signed-in people only, cached as immutable.
  const pic = await a.request.get(row!.image as string)
  expect(pic.status()).toBe(200)
  expect(pic.headers()['content-type']).toBe('image/webp')
  expect(pic.headers()['cache-control']).toContain('immutable')
  const anon = await browser.newContext()
  expect((await anon.request.get(row!.image as string)).status()).toBe(401)
  await anon.close()

  // ── A posts in a new channel: the row shows A's picture and name ──
  await expect(a.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await a.getByTestId('messages-new-channel').click()
  await a.locator('#channel-name').fill(channel)
  await a.getByTestId('channel-create').click()
  await expect(a.getByTestId('messages-title')).toContainText(channel)
  await a.getByTestId('messages-composer').fill('Hi, I’m new here')
  await a.getByTestId('messages-composer').press('Enter')
  const mine = a.getByTestId('messages-item').filter({ hasText: 'Hi, I’m new here' })
  await expect(mine.getByTestId('messages-author')).toHaveText(`Pia ${last}`)
  await expect(mine.getByTestId('messages-avatar')).toHaveAttribute('data-has-image', 'true')
  await expect.poll(() => loadedWidth(mine.getByTestId('messages-avatar').locator('img'))).toBe(256)
  await a.screenshot({ path: `${SHOTS}/03-messages-own-avatar.png` })

  // ── B sees A's name and picture, live ──
  const ctxB = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const b = await ctxB.newPage()
  await member(ctxB, b, 'Bo', `Reader${suffix}`)
  await b.goto('/messages')
  await expect(b.getByTestId('messages-live')).toHaveAttribute('data-state', 'live')
  await b.getByTestId('messages-list').locator(`[data-testid="messages-conversation"][data-title="${channel}"]`).click()
  const seen = b.getByTestId('messages-item').filter({ hasText: 'Hi, I’m new here' })
  await expect(seen.getByTestId('messages-author')).toHaveText(`Pia ${last}`)
  await expect.poll(() => loadedWidth(seen.getByTestId('messages-avatar').locator('img'))).toBe(256)
  await a.getByTestId('messages-composer').fill('Welcome me, Bo')
  await a.getByTestId('messages-composer').press('Enter')
  const live = b.getByTestId('messages-item').filter({ hasText: 'Welcome me, Bo' })
  await expect(live).toBeVisible()
  // Same author within minutes: a grouped row — no second avatar or name.
  await expect(live).toHaveAttribute('data-grouped', 'true')
  await expect(live.getByTestId('messages-avatar')).toHaveCount(0)
  // The header counts the channel's members with their avatars.
  await expect(b.getByTestId('messages-members')).toHaveAttribute('data-count', /\d+/)
  await b.screenshot({ path: `${SHOTS}/04-member-sees-avatar.png` })

  // ── Settings › Account edits the same profile ──
  await a.goto('/settings')
  await expect(a.getByTestId('settings-profile').getByTestId('profile-avatar')).toHaveAttribute('data-has-image', 'true')
  await expect(a.getByTestId('profile-last-name')).toHaveValue(last)
  await a.getByTestId('profile-last-name').fill(`${last}-Smith`)
  await a.getByTestId('profile-save').click()
  await expect(a.getByTestId('profile-notice')).toHaveText('Profile saved.')
  await a.screenshot({ path: `${SHOTS}/05-settings-account.png`, fullPage: true })
  await b.reload()
  await expect(b.getByTestId('messages-item').filter({ hasText: 'Hi, I’m new here' }).getByTestId('messages-author')).toHaveText(
    `Pia ${last}-Smith`,
  )

  await ctxA.close()
  await ctxB.close()
})
