import { expect, test, type Browser, type Page } from '@playwright/test'
import postgres from 'postgres'
import { HUB_CONTRIBUTION_KEYS, HUB_PATHS, hubContributionV1 } from '../../../modules/contribute/share/contract'
import { registerUser } from './test-helpers'

/**
 * Contribute phone-home (plan/contribute-phone-home.md §6 step 5): the owner
 * finds sharing on by default in Settings → Company; a member proposes
 * something with a person's name and a URL in it; one sharing pass (the
 * harness trigger runs what the job-queue tick runs) scrubs it on the company
 * provider (the mock gateway answers the `contribute_scrub` call) and sends a
 * signed PUT to the mock central board (scripts/mock-hub.ts) — exactly the
 * contract's keys, no name, no URL. The owner sees the same payload under
 * "Show what was sent", marks it "Don't share" (the hub gets a DELETE with an
 * empty body) and turns sharing off.
 *
 * Instance-global state: the single sharing row is reset to a fresh install
 * (on, no identity — the harness's key dir is new each run), earlier rows in
 * the outbox are parked as never shared (like the migration's no-backfill),
 * and the owner role is borrowed and given back.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

const SHOTS = process.env.CONTRIBUTE_SHOTS ?? 'test-results/contribute-phone-home'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const HUB_URL = `http://127.0.0.1:${process.env.MOCK_HUB_PORT ?? 5198}`

let _sql: postgres.Sql | null = null
const sql = (): postgres.Sql => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
const stamp = Date.now()
const emails: string[] = []
let previousOwner: string | null = null
let ourOwner: string | null = null

const resetSharing = async () => {
  await sql()`update contribute_share_settings
    set enabled = true, install_id = null, registered_at = null, revoked_at = null, last_error = null, updated_at = now()
    where id = 1`
}

test.beforeAll(async () => {
  await resetSharing()
  await sql()`update contribute_outbox set state = 'excluded', last_sent_hash = null, last_error = null, updated_at = now()`
})

test.afterAll(async () => {
  await sql()`delete from contributions where title like ${`%e2e-${stamp}%`}`
  // Back to a fresh install's default (on): the next run's key dir is new.
  await resetSharing()
  for (const email of emails) await sql()`update "user" set role = 'member' where email = ${email} and role = 'admin'`
  if (ourOwner) await sql()`update "user" set role = 'admin' where id = ${ourOwner}`
  if (previousOwner) await sql()`update "user" set role = 'owner' where id = ${previousOwner}`
  await _sql?.end()
})

const b64 = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url')
/** The judge's verdict ("Draft:" call) and the scrub's answer ("Proposal:" call), carried to the mock gateway in the text. */
const judgeMarker = (v: { kind: string; area: string; duplicate_of: string | null }) => `[mock-json:${b64(v)}]`
const scrubMarker = (v: { summary: string; language: string; removed: string[] }) => `[mock-json@Proposal:${b64(v)}]`

async function signIn(browser: Browser, role: 'owner' | 'member'): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const page = await context.newPage()
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  emails.push(email)
  if (role === 'owner') {
    // The single-owner index: the current owner (if any) steps aside for this run.
    const [prev] = await sql()<{ id: string }[]>`select id from "user" where role = 'owner'`
    if (prev) {
      previousOwner = prev.id
      await sql()`update "user" set role = 'admin' where id = ${prev.id}`
    }
    const [me] = await sql()<{ id: string }[]>`update "user" set role = 'owner' where email = ${email} returning id`
    if (!me) throw new Error(`could not make ${email} the owner`)
    ourOwner = me.id
  }
  await sql()`update "user" set onboarding_completed = true where email = ${email}`
  // The owner's provider is the company's: the scrub runs on it.
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

async function hydrated(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
}

type HubRequest = { method: string; path: string; body: string; signatureOk: boolean | null; status: number }

async function hubRequests(page: Page): Promise<HubRequest[]> {
  const res = await page.request.get(`${HUB_URL}/__mock-hub/requests`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as { requests: HubRequest[] }).requests
}

/** One sharing pass now (what the job-queue tick runs every minute). */
async function sharePass(page: Page): Promise<void> {
  const res = await page.request.post('/api/e2e/harness/contribute-share')
  expect(res.status()).toBe(200)
}

async function openSettings(owner: Page): Promise<void> {
  await owner.goto('/settings/company')
  await hydrated(owner)
  await expect(owner.getByTestId('share-settings')).toBeVisible()
}

test('Contribute phone-home: on by default, scrubbed and signed to the central board, shown, withdrawn, turned off', async ({ browser }) => {
  test.setTimeout(180_000)
  const owner = await signIn(browser, 'owner')

  await test.step('the owner sees sharing on by default in Settings → Company', async () => {
    await openSettings(owner)
    await expect(owner.getByTestId('share-enabled')).toHaveText('On')
    await expect(owner.getByTestId('share-not-configured')).toHaveCount(0)
    await expect(owner.getByTestId('share-no-provider')).toHaveCount(0)
    await expect(owner.getByTestId('share-toggle')).toHaveText('Turn sharing off')
    await owner.screenshot({ path: `${SHOTS}/1-settings-on.png`, fullPage: true })
  })

  const member = await signIn(browser, 'member')
  const name = 'Marianne Okonkwo-Velasquez'
  const host = 'tracker.kindred-e2e.example'
  const url = `https://${host}/t/4711`
  const summary = 'Threads should keep every reply instead of losing some.'
  const title = `Ask ${name} — threads lose replies, see ${url} e2e-${stamp}`

  await test.step('a member proposes something with a name and a URL in it', async () => {
    await member.goto('/m/website')
    await hydrated(member)
    await member.getByTestId('shell-topbar').getByTestId('contribute-trigger').click()
    await member
      .getByTestId('contribute-input')
      .fill(
        `${title} ${judgeMarker({ kind: 'bug', area: 'messages', duplicate_of: null })} ${scrubMarker({ summary, language: 'en', removed: ['person', 'url'] })}`,
      )
    await member.getByTestId('contribute-send').click()
    await expect(member.getByTestId('contribute-done')).toContainText('Thanks — it’s on the board.')
  })

  const [stored] = await sql()<{ id: string; title: string }[]>`select id, title from contributions where title like ${`${title}%`}`
  expect(stored).toBeDefined()
  const [queued] = await sql()<{ state: string }[]>`select state from contribute_outbox where contribution_id = ${stored.id}`
  expect(queued?.state).toBe('pending')
  const putPath = HUB_PATHS.contribution(stored.id)

  let sentBody = ''
  await test.step('the sharing pass runs: the mock hub receives exactly the allowlisted keys, no name, no URL', async () => {
    await expect
      .poll(
        async () => {
          await sharePass(owner)
          return (await hubRequests(owner)).some((r) => r.method === 'PUT' && r.path === putPath && r.status === 201)
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true)
    const requests = await hubRequests(owner)
    expect(requests.filter((r) => r.method === 'POST' && r.path === HUB_PATHS.register).map((r) => r.status)).toContain(201)
    const puts = requests.filter((r) => r.method === 'PUT' && r.path === putPath)
    expect(puts).toHaveLength(1)
    const [put] = puts
    expect(put.signatureOk).toBe(true)
    sentBody = put.body
    const sent = JSON.parse(sentBody) as Record<string, unknown>
    expect(Object.keys(sent).sort()).toEqual([...HUB_CONTRIBUTION_KEYS].sort())
    expect(hubContributionV1.parse(sent)).toMatchObject({
      v: 1,
      remote_id: stored.id,
      summary,
      language: 'en',
      kind: 'bug',
      area: 'messages',
      status: 'requested',
      score: 1,
    })
    for (const leak of [name, 'Marianne', 'Okonkwo', host, url, 'https://', `e2e-${stamp}`, 'mock-json']) {
      expect(sentBody).not.toContain(leak)
    }
  })

  await test.step('the owner opens "Show what was sent" and sees the same payload', async () => {
    await owner.goto('/contribute')
    await hydrated(owner)
    const row = owner.getByTestId('contribute-row').filter({ hasText: `e2e-${stamp}` })
    await expect(row.getByTestId('contribute-share-state')).toHaveText('Shared')
    await row.getByRole('button', { name: 'Show what was sent' }).click()
    const shown = row.getByTestId('contribute-sent-payload')
    await expect(shown).toBeVisible()
    expect(JSON.parse((await shown.textContent()) ?? '')).toEqual(JSON.parse(sentBody))
    await owner.screenshot({ path: `${SHOTS}/2-what-was-sent.png`, fullPage: true })
  })

  await test.step('the owner marks it "Don\'t share": the hub receives a DELETE with an empty body', async () => {
    const row = owner.getByTestId('contribute-row').filter({ hasText: `e2e-${stamp}` })
    await row.getByRole('button', { name: "Don't share" }).click()
    await expect(row.getByTestId('contribute-share-state')).toContainText('Not shared')
    await expect
      .poll(
        async () => {
          await sharePass(owner)
          return (await hubRequests(owner)).some((r) => r.method === 'DELETE' && r.path === putPath && r.status === 200)
        },
        { timeout: 60_000, intervals: [500, 1000, 2000] },
      )
      .toBe(true)
    const deletes = (await hubRequests(owner)).filter((r) => r.method === 'DELETE' && r.path === putPath)
    expect(deletes).toHaveLength(1)
    expect(deletes[0]).toMatchObject({ body: '', signatureOk: true, status: 200 })
    await owner.reload()
    await hydrated(owner)
    await expect(owner.getByTestId('contribute-row').filter({ hasText: `e2e-${stamp}` }).getByTestId('contribute-share-state')).toHaveText(
      'Not shared',
    )
  })

  await test.step('the owner turns sharing off in Settings', async () => {
    await openSettings(owner)
    await owner.getByTestId('share-toggle').click()
    await expect(owner.getByTestId('share-enabled')).toHaveText('Off')
    await expect(owner.getByTestId('share-toggle')).toHaveText('Turn sharing on')
    await owner.reload()
    await hydrated(owner)
    await expect(owner.getByTestId('share-enabled')).toHaveText('Off')
    const [row] = await sql()<{ enabled: boolean }[]>`select enabled from contribute_share_settings where id = 1`
    expect(row.enabled).toBe(false)
    await owner.screenshot({ path: `${SHOTS}/3-settings-off.png`, fullPage: true })
  })
})
