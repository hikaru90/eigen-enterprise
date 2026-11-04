import { expect, test, type Page } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * D8 live run view (plan/phase-durable.md D8, software-factory S0): a chat
 * turn runs on the durable engine; two company members open the same run in
 * two browsers and both see its live events (snapshot on connect, then the
 * next turn's batches), and anonymous callers are refused. Since polish P-1
 * the runs are the assistant's conversations: listed at /assistant and in the
 * assistant panel's History tab, each one a page at /assistant/[id].
 */

const GATEWAY_BASE_URL = `http://127.0.0.1:${process.env.MOCK_GATEWAY_PORT ?? 5199}/v1`

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

async function chat(page: Page, message: string, sessionId?: string): Promise<string> {
  const res = await page.request.post('/api/chat', {
    data: { message, ...(sessionId ? { sessionId } : {}) },
    timeout: 60_000,
  })
  // The mock gateway answers with a native tool call (website.list_pages), then a
  // plain answer once the tool result is back (scripts/mock-gateway-chat.mjs).
  const body = (await res.json()) as { sessionId?: string }
  expect(res.status(), JSON.stringify(body)).toBe(200)
  expect(body.sessionId, JSON.stringify(body)).toBeTruthy()
  return body.sessionId!
}

test.describe('agent runs live view', () => {
  test('two members watch the same durable run live', async ({ browser, page, context }) => {
    await registerUser(context, page)
    await connectProvider(page)

    const marker = `first-turn-${Date.now()}`
    const sessionId = await chat(page, marker)

    const list = await page.request.get('/api/agent/runs')
    expect(list.status()).toBe(200)
    const { runs } = (await list.json()) as {
      runs: Array<{ id: number; conversationKey: string } & Record<string, unknown>>
    }
    const run = runs.find((r) => r.conversationKey.endsWith(`:${sessionId}`))
    expect(run, JSON.stringify(runs)).toBeTruthy()
    // Metadata only: no attribution keys leave the server.
    expect(Object.keys(run!)).not.toContain('providerSessionId')
    expect(Object.keys(run!)).not.toContain('llmUserId')

    // Browser A: the assistant panel's History tab lists the conversation and
    // opens its run view.
    await page.goto('/m/website')
    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-tab-history').click()
    const historyRow = page
      .getByTestId('assistant-history-item')
      .and(page.locator(`a[href="/assistant/${run!.id}"]`))
    // A human title: what the conversation is about (its first message).
    await expect(historyRow).toContainText(marker)
    await page.getByTestId('assistant-close').click()

    // The same list as a linkable page.
    await page.goto('/assistant')
    await expect(page.getByRole('heading', { level: 1, name: 'Assistant' })).toBeVisible()
    await expect(page.getByRole('heading', { level: 2, name: 'Conversations' })).toBeVisible()
    // A readable title, not the agent id and its raw conversation key.
    const row = page.locator(`a[href="/assistant/${run!.id}"]`)
    await expect(row.getByTestId('runs-item-title')).toHaveText(marker)
    await expect(row).not.toContainText(run!.conversationKey)
    await row.click()
    await expect(page).toHaveURL(new RegExp(`/assistant/${run!.id}$`))
    await expect(page.getByTestId('run-title')).toHaveText(marker)
    await expect(page).toHaveTitle(new RegExp(`^${marker} · Assistant · eigenEnterprise$`))

    // Browser B: a second company member in a separate context.
    const otherContext = await browser.newContext()
    const other = await otherContext.newPage()
    await registerUser(otherContext, other)
    await other.goto(`/assistant/${run!.id}`)

    for (const p of [page, other]) {
      const feed = p.getByRole('log', { name: 'Run events' })
      // Snapshot on connect: the committed first turn is already there.
      await expect(feed.getByText(marker)).toBeVisible()
      await expect(p.getByTestId('run-feed-status')).toHaveText(/Idle|Running/)
    }

    // A second turn on the same session = the same durable conversation; both
    // open pages receive it live (no reload).
    const second = `second-turn-${Date.now()}`
    await chat(page, second, sessionId)
    for (const p of [page, other]) {
      const feed = p.getByRole('log', { name: 'Run events' })
      await expect(feed.getByText(second)).toBeVisible()
      await expect(feed.getByText('Run started').last()).toBeVisible()
      await expect(feed.getByText('Run finished').last()).toBeVisible()
      // The native tool call shows up as a tool line that finished.
      await expect(p.getByTestId('run-feed-tool').last()).toContainText('website.list_pages')
      await expect(p.getByTestId('run-feed-tool').last()).toContainText('done')
      await expect(p.getByTestId('run-feed-status')).toHaveText('Idle')
    }
    await page.screenshot({ path: 'test-results/agent-runs-live-a.png', fullPage: true })
    await other.screenshot({ path: 'test-results/agent-runs-live-b.png', fullPage: true })

    // Anonymous callers are refused (fail closed).
    const anon = await browser.newContext()
    const anonList = await anon.request.get('/api/agent/runs')
    expect(anonList.status()).toBe(401)
    const anonEvents = await anon.request.get(`/api/agent/runs/${run!.id}/events`)
    expect(anonEvents.status()).toBe(401)
    await anon.close()
    await otherContext.close()
  })
})
