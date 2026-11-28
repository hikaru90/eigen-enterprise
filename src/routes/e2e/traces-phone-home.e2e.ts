import { expect, test, type Browser, type Page } from './e2e-test'
import postgres from 'postgres'
import { completeProfileViaApi, profileNames, registerUser } from './test-helpers'

/**
 * Traces phone-home (plan/traces-phone-home.md T4): the owner meets the one-time "Needs you"
 * notice (what is shared, where the switch is) and marks it seen; a co-worker runs a rhythm whose
 * instruction names a person and an email address (the mock gateway answers its model call); one
 * export pass (the harness runs what the job-queue tick runs, on a clock past the settle and build
 * waits) sends a signed batch to the mock hub (scripts/mock-hub.ts) — every span has exactly the
 * Tier A keys, and none of the name, email or instruction text is anywhere in what was sent. The
 * owner deletes everything sent from the hub: the hub gets a DELETE with an empty body.
 *
 * Instance-global state: the traces settings row is reset to a fresh install's (on, notice
 * unseen), the export cursors are placed at the start (no backfill of other specs' rows), the
 * Contribute identity is reset (the harness's hub is new each run), and the owner role is
 * borrowed and given back.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey prepares its users in the test DB')

const SHOTS = process.env.TRACES_SHOTS ?? 'test-results/traces-phone-home'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const HUB_URL = `http://127.0.0.1:${process.env.MOCK_HUB_PORT ?? 5198}`

/**
 * The Tier A keys of a span (modules/traces/payload.ts hubSpanV1), stated here on purpose: the
 * journey checks the allowlist from outside (and Playwright's loader cannot import the module).
 */
const TIER_A_KEYS = [
  'trace_id', 'span_id', 'parent_id', 'kind', 'run_kind', 'tool', 'log_context', 'model', 'provider_kind', 'tokens_in', 'tokens_out',
  'cost_usd', 'duration_ms', 'attempt', 'start_offset_ms', 'outcome', 'error_code', 'audit_class', 'via', 'app_version', 'ee_version', 'day',
]
/** modules/traces/store.ts TRACE_SOURCES. */
const TRACE_SOURCES = ['llm_call', 'tool_call', 'run', 'job', 'upgrade', 'module_run']
/** Past modules/traces/worker.ts BUILD_EVERY_MS (15 min) + SETTLE_MS (1 min). */
const AHEAD_MS = 17 * 60_000

let _sql: postgres.Sql | null = null
const sql = (): postgres.Sql => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))
const stamp = Date.now()
let previousOwner: string | null = null
let ourOwner: string | null = null

const resetTraces = async () => {
  await sql()`insert into trace_share_settings (id, salt) values (1, ${`e2e-${stamp}`}) on conflict (id) do nothing`
  await sql()`update trace_share_settings set enabled = true, last_error = null, notice_seen_at = null, updated_at = now() where id = 1`
  // Batches the harness built on a clock ahead of now would hold the build interval back.
  await sql()`delete from trace_batch where created_at > now()`
}

test.beforeAll(async () => {
  await resetTraces()
  // No backfill: only rows after this point are exported.
  for (const source of TRACE_SOURCES) {
    await sql()`insert into trace_export_cursor (source, last_at, last_id) values (${source}, now(), '')
      on conflict (source) do update set last_at = now(), last_id = '', updated_at = now()`
  }
  await sql()`update contribute_share_settings
    set enabled = true, install_id = null, registered_at = null, revoked_at = null, last_error = null, updated_at = now()
    where id = 1`
})

test.afterAll(async () => {
  await resetTraces()
  if (ourOwner) await sql()`update "user" set role = 'member' where id = ${ourOwner}`
  if (previousOwner) await sql()`update "user" set role = 'owner' where id = ${previousOwner}`
  await _sql?.end()
})

async function signInOwner(browser: Browser): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } })
  const page = await context.newPage()
  const { email } = await registerUser(context, page, { emailDomain: 'test.eigen' })
  const [prev] = await sql()<{ id: string }[]>`select id from "user" where role = 'owner'`
  if (prev) {
    previousOwner = prev.id
    await sql()`update "user" set role = 'admin' where id = ${prev.id}`
  }
  const [me] = await sql()<{ id: string }[]>`update "user" set role = 'owner', onboarding_completed = true where email = ${email} returning id`
  if (!me) throw new Error(`could not make ${email} the owner`)
  ourOwner = me.id
  const saved = await page.request.post('/api/onboarding/provider', {
    data: { provider: 'openrouter', baseUrl: GATEWAY_BASE_URL, apiKey: `e2e-key-${stamp}`, modelChat: 'mock-chat-model', modelEmbedding: 'mock-embed-model' },
  })
  expect(saved.status(), await saved.text()).toBe(200)
  return page
}

async function hydrated(page: Page): Promise<void> {
  await expect(page.locator('body')).toHaveAttribute('data-eigen-hydrated', 'true')
}

/** A SvelteKit form action as the signed-in person (same origin, like the page's own form). */
async function action(page: Page, path: string, fields: Record<string, string | string[]>): Promise<void> {
  const form = new URLSearchParams()
  for (const [k, v] of Object.entries(fields)) for (const one of Array.isArray(v) ? v : [v]) form.append(k, one)
  const origin = new URL(page.url()).origin
  const res = await page.request.post(path, {
    headers: { origin, 'content-type': 'application/x-www-form-urlencoded', 'x-sveltekit-action': 'true' },
    data: form.toString(),
  })
  const body = await res.text()
  expect(res.status(), body).toBe(200)
  expect(JSON.parse(body).type, body).toBe('success')
}

type HubRequest = { method: string; path: string; body: string; signatureOk: boolean | null; status: number }

async function hubRequests(page: Page): Promise<HubRequest[]> {
  const res = await page.request.get(`${HUB_URL}/__mock-hub/requests`)
  expect(res.status()).toBe(200)
  return ((await res.json()) as { requests: HubRequest[] }).requests.filter((r) => r.path.startsWith('/api/hub/traces'))
}

test('Traces phone-home: the owner’s notice, a run with a name and an email sends only Tier A keys, withdrawn on DELETE', async ({ browser }) => {
  test.setTimeout(180_000)
  const owner = await signInOwner(browser)

  await test.step('the owner sees the one-time product signals notice in Needs you, and marks it seen', async () => {
    await owner.goto('/')
    await hydrated(owner)
    const notice = owner.getByTestId('dashboard-signals-notice')
    await expect(notice).toContainText('usage statistics')
    await expect(notice.getByTestId('dashboard-signals-open')).toHaveAttribute('href', '/settings/company')
    await owner.screenshot({ path: `${SHOTS}/1-needs-you-notice.png`, fullPage: true })
    await notice.getByTestId('dashboard-signals-seen').click()
    await expect(owner.getByTestId('dashboard-signals-notice')).toHaveCount(0)
    await owner.reload()
    await hydrated(owner)
    await expect(owner.getByTestId('dashboard-signals-notice')).toHaveCount(0)
  })

  const person = 'Marianne Okonkwo-Velasquez'
  const email = `marianne.okonkwo-${stamp}@kindred-e2e.example`
  const instruction = `Write a short note to ${person} (${email}) about the launch.`
  const cwName = `Signal ${stamp.toString(36)}`

  await test.step('a co-worker runs a rhythm whose instruction holds a name and an email', async () => {
    // The co-worker service looks the owner up among production accounts, and those have a profile.
    await sql()`update "user" set account_kind = 'production' where id = ${ourOwner!}`
    await completeProfileViaApi(owner, profileNames(`Olga Owner${stamp.toString(36)}`))
    await owner.goto('/settings/coworkers')
    await hydrated(owner)
    await action(owner, '/settings/coworkers?/create', {
      template_id: 'marketing-manager',
      name: cwName,
      title: 'Head of Launches',
      lens: 'You care that every launch note is short and clear.',
      accountabilities: 'Write the launch notes',
    })
    const [cw] = await sql()<{ id: string }[]>`select id from "user" where name = ${cwName}`
    expect(cw, 'the co-worker was created').toBeTruthy()
    const channel = await owner.request.post('/api/messages/channels', { data: { name: `signals-${stamp}`, private: true, userIds: [cw!.id] } })
    expect(channel.status(), await channel.text()).toBe(200)
    const conversationId = ((await channel.json()) as { conversation: { id: string } }).conversation.id
    await action(owner, '/settings/coworkers?/rhythmCreate', {
      user_id: cw!.id,
      weekdays_sent: '1',
      weekdays: 'MO',
      time: '09:00',
      time_zone: 'Europe/Berlin',
      instruction,
      conversation_id: conversationId,
    })
    const [rhythm] = await sql()<{ id: string }[]>`select id from coworker_rhythm where coworker_user_id = ${cw!.id}`
    await action(owner, '/settings/coworkers?/rhythmRunNow', { user_id: cw!.id, rhythm_id: rhythm!.id })
    await expect
      .poll(async () => (await sql()<{ n: number }[]>`select count(*)::int as n from coworker_run where coworker_user_id = ${cw!.id} and ended_at is not null`)[0]!.n, {
        timeout: 60_000,
      })
      .toBeGreaterThan(0)
  })

  await test.step('one export pass sends spans with only the Tier A keys — no name, no email, no instruction', async () => {
    const tick = await owner.request.post('/api/e2e/harness/traces-tick', { data: { ahead_ms: AHEAD_MS } })
    expect(tick.status(), await tick.text()).toBe(200)
    expect(((await tick.json()) as { result: { sent: number } | null }).result).toMatchObject({ sent: 1 })
    const posts = (await hubRequests(owner)).filter((r) => r.method === 'POST')
    expect(posts.length).toBeGreaterThan(0)
    for (const p of posts) {
      expect(p.signatureOk).toBe(true)
      expect(p.status).toBe(201)
      const batch = JSON.parse(p.body) as { v: number; batch_id: string; spans: Array<Record<string, unknown>> }
      expect(Object.keys(batch).sort()).toEqual(['batch_id', 'spans', 'v'])
      for (const s of batch.spans) expect(Object.keys(s).sort()).toEqual([...TIER_A_KEYS].sort())
      for (const text of [person, 'Okonkwo', email, 'kindred-e2e', instruction, cwName, 'launch']) expect(p.body).not.toContain(text)
    }
    const spans = posts.flatMap((p) => (JSON.parse(p.body) as { spans: Array<Record<string, unknown>> }).spans)
    expect(spans.some((s) => s.kind === 'run' && s.run_kind === 'coworker:rhythm')).toBe(true)
  })

  await test.step('the owner deletes everything sent: the hub gets a DELETE with an empty body', async () => {
    await owner.goto('/settings/company/signals')
    await hydrated(owner)
    await expect(owner.getByTestId('signals-batches')).toBeVisible()
    await owner.screenshot({ path: `${SHOTS}/2-what-was-sent.png`, fullPage: true })
    await owner.getByTestId('signals-withdraw-all').click()
    await expect(owner.getByTestId('signals-withdraw-all')).toHaveCount(0)
    const deletes = (await hubRequests(owner)).filter((r) => r.method === 'DELETE')
    expect(deletes).toEqual([expect.objectContaining({ path: '/api/hub/traces', body: '', signatureOk: true, status: 200 })])
  })
})
