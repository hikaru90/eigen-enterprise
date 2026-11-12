import { expect, test, type Page } from '@playwright/test'
import { becomeCompanyOwner, type CompanyOwnerSwap } from './company-owner'
import { registerUser } from './test-helpers'

/**
 * The Assistant's linkable pages (plan/phase-polish-1.md P-1): the Agent area
 * is gone; Conversations (/assistant) · Activity (/assistant/activity) are
 * the panel's History and Activity, each its own URL. Driven end to end: a chat
 * turn on the durable engine creates a run (mock gateway: one native tool
 * call website.list_pages, then a plain answer); the run is listed under
 * Conversations and the same turn reads as plain words under Activity. The
 * old URLs 404. The Roadmap moved into Memory (P-4): memory-roadmap.e2e.ts drives it.
 *
 * The user is the company owner for the run (its provider is the company's — every
 * turn runs on it) and steps back after.
 */

const DATABASE_URL = process.env.DATABASE_URL?.trim()
test.skip(!DATABASE_URL, 'DATABASE_URL not set — the journey makes its user the owner in the test DB')

const SHOTS = 'test-results/assistant-area'
const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`
let email = ''
let owner: CompanyOwnerSwap | null = null

test.afterAll(async () => {
  await owner?.restore()
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

test('Assistant → Conversations → run → Activity', async ({ page, context }) => {
  test.setTimeout(180_000)
  ;({ email } = await registerUser(context, page, { emailDomain: 'test.eigenlabs.dev' }))
  owner = await becomeCompanyOwner(email)
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

  // No Agent nav entry any more; /assistant lists the conversation and opens it.
  await page.setViewportSize({ width: 1280, height: 800 })
  await page.goto('/')
  await expect(page.getByTestId('shell-sidebar').getByTestId('shell-nav-agent')).toHaveCount(0)
  await page.goto('/assistant')
  await expect(page).toHaveTitle(/^Conversations · Assistant · /)
  await expect(page.getByRole('heading', { level: 1, name: 'Assistant' })).toBeVisible()
  await expect(page.getByTestId('assistant-nav-conversations')).toHaveAttribute('aria-current', 'page')
  const runLink = page.locator(`a[href="/assistant/${run!.id}"]`)
  await expect(runLink).toBeVisible()
  await page.screenshot({ path: `${SHOTS}/1-conversations.png`, fullPage: true })
  await runLink.click()
  await expect(page.getByTestId('run-title')).toBeVisible()
  await expect(page.getByRole('log', { name: 'Run events' }).getByText(marker)).toBeVisible()

  // Activity: the same turn, in plain words — no event types, no ids up front.
  await page.getByTestId('assistant-nav-activity').click()
  await expect(page).toHaveURL(/\/assistant\/activity$/)
  await expect(page).toHaveTitle(/^Activity · Assistant · /)
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
  for (const path of [
    '/runs',
    `/runs/${run!.id}`,
    '/activity',
    '/settings/extensions',
    '/agent',
    `/agent/runs/${run!.id}`,
    '/agent/activity',
  ]) {
    const res = await page.goto(path)
    expect(res?.status(), path).toBe(404)
  }
})
