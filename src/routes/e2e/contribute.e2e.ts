import { expect, test, type Browser, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * Contribute (Eigen's board, in eigenEnterprise): the top bar's Contribute
 * button (top right) opens the composer; Send runs the LLM judge through the
 * gateway (the mock answers the verdict a [mock-json:…] marker carries) and
 * the proposal lands on /contribute with its author's +1. A second person
 * drafting the same request gets the chorus card and votes for it instead.
 * An admin moves it to In progress with a note; the member sees both.
 * Screenshots go to CONTRIBUTE_SHOTS (default test-results/contribute).
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

const SHOTS = process.env.CONTRIBUTE_SHOTS ?? 'test-results/contribute'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

let _sql: postgres.Sql | null = null
const sql = (): postgres.Sql => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
const emails: string[] = []
const stamp = Date.now()

test.afterAll(async () => {
  await sql()`delete from contributions where title like ${`%e2e-${stamp}%`}`
  for (const email of emails)
    await sql()`update "user" set role = 'member' where email = ${email} and role = 'admin'`
  await _sql?.end()
})

/** The judge's verdict, carried to the mock gateway inside the draft. */
const verdict = (v: { kind: string; area: string; duplicate_of: string | null }) =>
  `[mock-json:${Buffer.from(JSON.stringify(v)).toString('base64url')}]`

async function signIn(browser: Browser, role: 'admin' | 'member'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const page = await context.newPage()
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  emails.push(email)
  if (role === 'admin')
    await sql()`update "user" set role = 'admin' where email = ${email} and role = 'member'`
  await sql()`update "user" set onboarding_completed = true where email = ${email}`
  const saved = await page.request.post('/api/onboarding/provider', {
    data: {
      provider: 'openrouter',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: 'mock-chat-model',
      modelEmbedding: 'mock-embed-model',
    },
  })
  expect(saved.status()).toBeLessThan(500)
  return page
}

/** After a full load: a click before hydration does nothing. */
async function hydrated(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
}

async function propose(page: Page, text: string): Promise<void> {
  await page.goto('/m/website')
  await hydrated(page)
  const trigger = page.getByTestId('shell-topbar').getByTestId('contribute-trigger')
  await expect(trigger).toBeVisible()
  await trigger.click()
  await page.getByTestId('contribute-input').fill(text)
  await page.getByTestId('contribute-send').click()
}

test('Contribute: propose from the top bar, vote instead on a duplicate, an admin picks it up', async ({ browser }) => {
  test.setTimeout(180_000)
  const member = await signIn(browser, 'member')
  const title = `Threads lose my replies e2e-${stamp}`

  await test.step('the member proposes from the top-right button; the judge reads it', async () => {
    await propose(member, `${title} ${verdict({ kind: 'bug', area: 'messages', duplicate_of: null })}`)
    const done = member.getByTestId('contribute-done')
    await expect(done).toContainText('Thanks — it’s on the board.')
    await expect(done).toContainText('Sounds like a bug in Messages')
    await member.screenshot({ path: `${SHOTS}/1-shared.png` })
    await done.getByRole('link', { name: 'See the board' }).click()
    await expect(member).toHaveURL(/\/contribute$/)
    await expect(member).toHaveTitle(/^Contribute · /)
    const row = member.getByTestId('contribute-row').filter({ hasText: title })
    await expect(row).toContainText('Bug · Messages · you')
    await expect(row.getByTestId('contribute-score')).toHaveText('1')
  })

  const [stored] = await sql()<{ id: string; kind: string; area: string; status: string }[]>`
    select id, kind, area, status from contributions where title like ${`${title}%`}`
  expect(stored).toMatchObject({ kind: 'bug', area: 'messages', status: 'requested' })

  const admin = await signIn(browser, 'admin')

  await test.step('the admin drafts the same request: the chorus card, vote for it instead', async () => {
    await propose(admin, `Replies vanish from threads e2e-${stamp} ${verdict({ kind: 'bug', area: 'messages', duplicate_of: stored.id })}`)
    const dup = admin.getByTestId('contribute-duplicate')
    await expect(dup).toContainText(title)
    await expect(dup).toContainText('1 vote · Requested')
    await admin.screenshot({ path: `${SHOTS}/2-duplicate.png` })
    await dup.getByRole('button', { name: 'Vote for it instead' }).click()
    await expect(admin.getByTestId('contribute-done')).toContainText('Your vote is in.')
    const [{ n }] = await sql()<{ n: number }[]>`select count(*)::int as n from contributions where title like ${`%e2e-${stamp}%`}`
    expect(n).toBe(1)
  })

  await test.step('the admin moves it to In progress with a note', async () => {
    await admin.goto('/contribute')
    await hydrated(admin)
    const row = admin.getByTestId('contribute-row').filter({ hasText: title })
    await expect(row.getByTestId('contribute-score')).toHaveText('2')
    await row.getByRole('button', { name: 'Add a note' }).click()
    await row.getByLabel('Note').fill('Picked up — building it now.')
    await row.getByRole('button', { name: 'Save note' }).click()
    await expect(row.getByTestId('contribute-note')).toHaveText('Picked up — building it now.')
    await row.getByLabel('Status').selectOption('in_progress')
    await admin.getByTestId('contribute-tab-in_progress').click()
    await expect(admin.getByTestId('contribute-row').filter({ hasText: title })).toBeVisible()
    await admin.screenshot({ path: `${SHOTS}/3-in-progress.png`, fullPage: true })
  })

  await test.step('the member sees it in progress, with the note; members cannot manage', async () => {
    await member.reload()
    await hydrated(member)
    await expect(member.getByTestId('contribute-tab-in_progress')).toContainText('In progress 1')
    await member.getByTestId('contribute-tab-in_progress').click()
    const row = member.getByTestId('contribute-row').filter({ hasText: title })
    await expect(row.getByTestId('contribute-note')).toHaveText('Picked up — building it now.')
    await expect(row.getByLabel('Status')).toHaveCount(0)
    const forbidden = await member.request.patch(`/api/contribute/${stored.id}`, { data: { status: 'shipped' } })
    expect(forbidden.status()).toBe(403)
  })
})
