import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * The website-founding journey, live: the 2026-10-14 owner bug report, driven
 * through the real chat surface against a real Postgres.
 *
 *  1. A pre-versioning (v1-shaped) ACTIVE founding row must abandon itself on
 *     the first chat touch — the plain orchestrator answers, no interview
 *     question, and `journey.abandoned` (reason spec_version) is on the audit
 *     log.
 *  2. A retried journey turn with pages already on disk must LEDGER the
 *     already-applied artifacts (deterministic probes via website.list_pages)
 *     instead of re-running them — "duplicate website slug" must be
 *     impossible, publishes still hit the owner approval gate.
 *  3. /api/tts contract: 401 unauthenticated, 400 on empty/oversized text,
 *     and an unreachable speech gateway surfaces the provider error as a loud
 *     500 — silence on the client, never a robot fallback.
 *
 * REQUIRES `E2E_JOURNEY_DATABASE_URL` — the Postgres URL BOTH the server under
 * test and this spec's SQL must use. The name deliberately avoids the generic
 * DATABASE_URL because playwright.config.ts loads .env with `override: true`;
 * a generic name would silently repoint this spec's SQL at whichever database
 * .env names — NOT the one the server under test uses. That mismatch corrupts
 * real data (it did, once); this spec aborts loudly instead. The tests reset
 * journey/page rows, so the URL must name a DISPOSABLE database. Skips loudly
 * without the env, like the PG-backed unit suites.
 */

const E2E_DATABASE_URL = process.env.E2E_JOURNEY_DATABASE_URL?.trim()

test.skip(!E2E_DATABASE_URL, 'E2E_JOURNEY_DATABASE_URL not set — run against a disposable DB')
if (E2E_DATABASE_URL && E2E_DATABASE_URL === process.env.DATABASE_URL) {
  throw new Error(
    'E2E_JOURNEY_DATABASE_URL equals DATABASE_URL — this spec resets journey/page rows; point it at a disposable database',
  )
}

/** Lazy handle — null never reaches a running test (module-level skip guards the unset case). */
let _sql: postgres.Sql | null = null
function sql(): postgres.Sql {
  _sql ??= postgres(E2E_DATABASE_URL!, { prepare: false })
  return _sql
}

const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
const CHAT_MODEL = 'mock-chat-model'
const EMBED_MODEL = 'mock-embed-model'

/** kernel_journeys admits ONE active row per kind, company-wide — clear the slot. */
/** The mind gate's heading (welcome-wizard.svelte MIND_HEADING). */
const MIND_HEADING = 'Now, it needs a mind to think with.'

/**
 * The boot's remaining identity lines (the modular-system lines): Continue
 * until the mind gate shows or the last line turns into Begin.
 */
async function continueThroughLines(page: Page): Promise<void> {
  const mind = page.getByText(MIND_HEADING)
  const begin = page.getByRole('button', { name: 'Begin' })
  const next = page.getByTestId('onboarding-continue')
  for (let i = 0; i < 10; i++) {
    await expect(mind.or(begin).or(next).first()).toBeVisible({ timeout: 15_000 })
    if ((await mind.isVisible()) || (await begin.isVisible())) return
    await next.click()
  }
  throw new Error('the boot never reached the mind gate or Begin')
}

async function resetJourneyState(): Promise<void> {
  await sql()`update kernel_journeys set status = 'abandoned' where kind = 'website_founding' and status = 'active'`
  await sql()`delete from website_content where slug in ('home', 'about', 'contact', 'brand-tone-of-voice')`
}

type JourneyStateRow = {
  stepIndex: number
  answers: Record<string, string>
  captured: string[]
  artifacts: Array<{ stepId: string; index: number; tool: string; status: string }>
  specVersion?: number
}

/** postgres.js may hand jsonb over as a raw string on this setup — accept both. */
function asState(raw: unknown): JourneyStateRow {
  if (typeof raw === 'string') return JSON.parse(raw) as JourneyStateRow
  return raw as JourneyStateRow
}

test.afterAll(async () => {
  await _sql?.end()
})

async function expectWizard(page: Page): Promise<void> {
  await expect(page.getByTestId('welcome-wizard')).toBeVisible({ timeout: 15_000 })
}

async function saveApiKeyViaApi(page: Page): Promise<void> {
  const saved = await page.request.post('/api/onboarding/provider', {
    data: {
      provider: 'openrouter',
      baseUrl: GATEWAY_BASE_URL,
      apiKey: `e2e-key-${Date.now()}`,
      modelChat: CHAT_MODEL,
      modelEmbedding: EMBED_MODEL,
    },
  })
  expect(saved.status()).toBe(200)
}

async function walkBootToMindGate(page: Page, name: string): Promise<void> {
  await expectWizard(page)
  await expect(page.getByText(/^Hello/)).toBeVisible()
  const nameAsk = page.getByRole('textbox', { name: 'Your name' })
  await expect(nameAsk).toBeVisible({ timeout: 15_000 })
  await nameAsk.fill(name)
  await nameAsk.press('Enter')
  const identityLine = page.getByText('This is the operating system for your company.')
  await expect(identityLine).toBeVisible({ timeout: 15_000 })
  await identityLine.click()
  await expect(page.getByText(/You talk\. It builds/)).toBeVisible({ timeout: 15_000 })
  await continueThroughLines(page)
  await expect(page.getByText(MIND_HEADING)).toBeVisible({ timeout: 20_000 })
}

async function finishBootWithProvider(page: Page, name: string): Promise<void> {
  await walkBootToMindGate(page, name)
  await saveApiKeyViaApi(page)
  await page.goto('/')
  await expectWizard(page)
  const identityLine = page.getByText('This is the operating system for your company.')
  await expect(identityLine).toBeVisible({ timeout: 15_000 })
  await identityLine.click()
  await expect(page.getByText(/You talk\. It builds/)).toBeVisible({ timeout: 15_000 })
  await continueThroughLines(page)
  const begin = page.getByRole('button', { name: 'Begin' })
  await expect(begin).toBeVisible({ timeout: 20_000 })
  await begin.click()
  // Assisted onboarding: the agent's own first turn (mock gateway text).
  await conversationLog(page)
}

async function sendHomepageMessage(page: Page, text: string): Promise<void> {
  const input = page.getByPlaceholder('What do you need?')
  await expect(input).toBeVisible()
  await input.click()
  await input.fill(text)
  await input.press('Enter')
}

async function conversationLog(page: Page): Promise<string> {
  const log = page.getByRole('log', { name: 'Conversation' })
  await expect
    .poll(async () => (await log.textContent()) ?? '', { timeout: 60_000, intervals: [500, 1000] })
    .toMatch(/Hello from mock gateway/i)
  return (await log.textContent()) ?? ''
}

test.describe('website-founding journey (live)', () => {
  test('a stale v1 journey abandons itself on "hi" — no interview, no duplicate-slug error', async ({
    page,
    context,
  }) => {
    await resetJourneyState()
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // Skip the tour; the provider gate is next — connect, land in the chat.
    await expectWizard(page)
    await page.getByTestId('skip-onboarding').click()
    await expect(page.getByText('Connect your AI provider.')).toBeVisible({ timeout: 15_000 })
    await saveApiKeyViaApi(page)
    await page.goto('/')
    await expect(page.getByPlaceholder('What do you need?')).toBeVisible({ timeout: 15_000 })

    // The 2026-09-10 legacy shape: active, pre-versioning, mid-interview.
    // (Skipping the tour no longer opens a journey — the agent opens it on the
    // owner's yes — so the legacy row is planted directly.)
    const openRow = await sql()`
      insert into kernel_journeys (kind, status, state)
      values ('website_founding', 'active', ${sql().json({
        stepIndex: 1,
        answers: { company_name: 'Legacy Haus' },
        captured: ['company_name'],
        artifacts: [],
      })}::jsonb)
      returning id
    `
    const journeyId = openRow[0].id as string

    await sendHomepageMessage(page, 'hi')
    const log = await conversationLog(page)

    // The bug this pins: "Error: duplicate website slug: brand-tone-of-voice".
    expect(log).not.toMatch(/duplicate/i)
    // The stale interview must not speak: no journey question in the reply.
    expect(log).not.toMatch(/tone of voice|positioning|company called/i)
    expect(log).toMatch(/Hello from mock gateway/i)

    const row = await sql()`select status, state from kernel_journeys where id = ${journeyId}`
    expect(row).toHaveLength(1)
    expect(row[0].status).toBe('abandoned')
    // Abandoned as stored — never re-stamped into a spec it never consented to.
    expect(asState(row[0].state).specVersion ?? null).toBeNull()

    const events = await sql()`
      select payload from kernel_events
      where type = 'journey.abandoned'
      order by ts desc limit 1
    `
    expect(events).toHaveLength(1)
    const payload = events[0].payload as { journeyId?: string; reason?: string }
    expect(payload.journeyId).toBe(journeyId)
    expect(payload.reason).toBe('spec_version')
  })

  test('a retried turn ledgers already-applied artifacts — publishes stay gated, no duplicate slug', async ({
    page,
    context,
  }) => {
    await resetJourneyState()
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })
    await finishBootWithProvider(page, 'Ada')

    // The hand-off opens no journey by itself (the agent opens it on the
    // owner's yes via its start marker — unit-pinned in brain.onboarding.spec):
    // plant an active current-spec row as if the owner had agreed.
    const before = await sql()`
      select id from kernel_journeys where kind = 'website_founding' and status = 'active'
    `
    expect(before).toHaveLength(0)
    const rows = await sql()`
      insert into kernel_journeys (kind, status, state)
      values ('website_founding', 'active', ${sql().json({
        stepIndex: 0, answers: {}, captured: [], artifacts: [], specVersion: 2,
      })}::jsonb)
      returning id
    `
    const journeyId = rows[0].id as string

    // The corruption the owner hit: the pages EXIST (an earlier flow created
    // them) while the current spec's ledger has no record — every turn
    // re-ran the creates and died on the unique slug.
    await sql()`
      insert into website_content (slug, kind, title, body, visibility)
      values
        ('home', 'page', 'Home', 'Already here.', 'public'),
        ('about', 'page', 'About', 'Already here.', 'private'),
        ('contact', 'page', 'Contact', 'Already here.', 'private'),
        ('brand-tone-of-voice', 'page', 'Brand — Tone of Voice', 'Already here.', 'private')
    `
    await sql()`
      update kernel_journeys set state = ${sql().json({
        stepIndex: 3,
        answers: {
          company_name: 'Verify Haus',
          positioning: 'We verify journeys end somewhere.',
          tone: 'honest, calm, precise',
        },
        captured: ['company_name', 'positioning', 'tone'],
        artifacts: [],
        specVersion: 2,
      })}::jsonb
      where id = ${journeyId}
    `

    await sendHomepageMessage(page, 'hi')
    const log = await conversationLog(page)
    expect(log).not.toMatch(/duplicate/i)
    expect(log).toMatch(/Hello from mock gateway/i)

    // Probes ledger the creates + the already-public home publish WITHOUT
    // re-running them; the about publish actually runs and stops at the
    // owner approval gate (the gate halts its step — the next step's
    // brand-doc create still runs and executes).
    let artifacts: JourneyStateRow['artifacts'] = []
    await expect
      .poll(
        async () => {
          const fresh = await sql()`select state, status from kernel_journeys where id = ${journeyId}`
          artifacts = asState(fresh[0].state).artifacts
          return artifacts.length
        },
        { timeout: 15_000, intervals: [500, 1000] },
      )
      .toBe(6)
    expect(artifacts.map((a) => `${a.tool}:${a.status}`).sort()).toEqual(
      [
        'website.create_page:executed',
        'website.create_page:executed',
        'website.create_page:executed',
        'website.create_page:executed',
        'website.publish_page:executed',
        'website.publish_page:approval_pending',
      ].sort(),
    )
    const row = await sql()`select status from kernel_journeys where id = ${journeyId}`
    expect(row[0].status).toBe('active')
  })

  test('/api/tts: 401 anon, 400 bad text, loud 500 when the gateway cannot speak', async ({
    page,
    context,
    request: standalone,
  }) => {
    await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' })

    // Anonymous (the standalone request fixture carries no session cookies).
    const unauth = await standalone.post('/api/tts', { data: { text: 'Hello there' } })
    expect(unauth.status()).toBe(401)

    const empty = await page.request.post('/api/tts', { data: { text: '   ' } })
    expect(empty.status()).toBe(400)
    const oversized = await page.request.post('/api/tts', {
      data: { text: 'a'.repeat(4001) },
    })
    expect(oversized.status()).toBe(400)

    // BYOK user on the mock gateway (no /audio/speech route): the provider's
    // failure surfaces as a loud 500 with a message — the client falls silent,
    // never back to the robot voice.
    await saveApiKeyViaApi(page)
    const failed = await page.request.post('/api/tts', { data: { text: 'Hello there' } })
    expect(failed.status()).toBe(500)
    const body = (await failed.json()) as { error?: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })
})
