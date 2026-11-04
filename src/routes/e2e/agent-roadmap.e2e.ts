import { expect, test, type Page } from '@playwright/test'
import postgres from 'postgres'
import { registerUser } from './test-helpers'

/**
 * The Agent area (plan/phase-cohesion.md §3, C3): one nav entry, three tabs —
 * Runs · Activity · Roadmap — each its own URL. Driven end to end: a chat
 * turn on the durable engine creates a run (mock gateway: one native tool
 * call website.list_pages, then a plain answer); the run is listed under
 * Runs and the same turn reads as plain words under Activity. The old URLs
 * 404. The Roadmap moved into Memory (P-4): memory-roadmap.e2e.ts drives it.
 *
 * The user is promoted to admin for the run and demoted after.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey promotes its user in the test DB')

let _sql: postgres.Sql | null = null
const sql = (): postgres.Sql => (_sql ??= postgres(DATABASE_URL!, { prepare: false }))

const SHOTS = 'test-results/agent-area'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
let email = ''

test.afterAll(async () => {
  if (email)
    await sql()`update "user" set role = 'member' where email = ${email} and role = 'admin'`
  await _sql?.end()
})

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

test('nav → Agent → Runs → Activity', async ({ page, context }) => {
  test.setTimeout(180_000)
  ;({ email } = await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' }))
  await sql()`update "user" set role = 'admin' where email = ${email} and role = 'member'`
  await connectProvider(page)

  const marker = `agent-area-${Date.now()}`
  const chat = await page.request.post('/api/chat', { data: { message: marker }, timeout: 60_000 })
  const body = (await chat.json()) as { sessionId?: string }
  expect(chat.status(), JSON.stringify(body)).toBe(200)
  const runs = (await (await page.request.get('/api/agent/runs')).json()) as {
    runs: Array<{ id: number; conversationKey: string }>
  }
  const run = runs.runs.find((r) => r.conversationKey.endsWith(`:${body.sessionId}`))
  expect(run, JSON.stringify(runs)).toBeTruthy()

  // The shell's Agent entry lands on Runs; the run is listed and opens.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/overview')
  const agentNav = page.getByTestId('shell-sidebar').getByTestId('shell-nav-agent')
  await expect(agentNav).toHaveAttribute('href', '/agent')
  await agentNav.click()
  await expect(page).toHaveURL(/\/agent\/runs$/)
  await expect(page).toHaveTitle(/^Runs · Agent · /)
  await expect(page.getByRole('heading', { level: 1, name: 'Agent' })).toBeVisible()
  await expect(page.getByRole('heading', { level: 2, name: 'Runs' })).toBeVisible()
  await expect(page.getByTestId('agent-nav-runs')).toHaveAttribute('aria-current', 'page')
  const runLink = page.locator(`a[href="/agent/runs/${run!.id}"]`)
  await expect(runLink).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/1-runs.png`, fullPage: true })
  await runLink.click()
  await expect(page.getByRole('heading', { name: `Run ${run!.id}` })).toBeVisible()
  await expect(page.getByRole('log', { name: 'Run events' }).getByText(marker)).toBeVisible()

  // Activity: the same turn, in plain words — no event types, no ids up front.
  await page.getByTestId('agent-nav-activity').click()
  await expect(page).toHaveURL(/\/agent\/activity$/)
  await expect(page).toHaveTitle(/^Activity · Agent · /)
  const log = page.getByTestId('activity-log')
  const toolLine = log
    .getByTestId('activity-entry')
    .filter({ hasText: 'Used Website: list pages' })
    .first()
  await expect(toolLine).toBeVisible()
  await expect(toolLine).toContainText('Agent')
  await expect(toolLine).toContainText('Done')
  await expect(log.getByText('Started working on a conversation').first()).toBeVisible()
  await expect(log.getByText('tool.executed').first()).toBeHidden()
  await page.screenshot({ path: `${SHOTS}/2-activity.png`, fullPage: true })
  // Details expand to the metadata, still no principal id.
  await toolLine.locator('summary').click()
  await expect(toolLine.getByTestId('activity-details')).toContainText('tool: website.list_pages')
  await expect(log).not.toContainText('orchestrator')
  // Filter by module.
  await page.getByTestId('activity-filter-website').click()
  await expect(page).toHaveURL(/module=website/)
  await expect(log.getByText('Started working on a conversation')).toHaveCount(0)
  await expect(log.getByText('Used Website: list pages').first()).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/3-activity-filtered.png`, fullPage: true })

  // The old URLs are gone (no redirects).
  for (const path of ['/runs', `/runs/${run!.id}`, '/activity', '/settings/extensions']) {
    const res = await page.goto(path)
    expect(res?.status(), path).toBe(404)
  }
})
