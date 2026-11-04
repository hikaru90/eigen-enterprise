import { expect, test, type Page } from '@playwright/test'
import { registerUser } from './test-helpers'

/**
 * Pricing transparency (AC-014, AC-015) on today's product: an AI call made
 * through the company's provider (the mock gateway in this harness) shows up
 * under Assistant → Activity › AI usage with its duration and credits — never raw
 * dollars or the markup. The AI call is one chat turn (the capture page's
 * interpret protocol is not something the mock gateway speaks).
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

async function oneChatTurn(page: Page): Promise<void> {
  const res = await page.request.post('/api/chat', {
    data: { message: `pricing check ${Date.now()}` },
    timeout: 60_000,
  })
  expect(res.status(), await res.text()).toBe(200)
}

/** The AI usage table, once its client-side load has rows (not the empty row). */
function usageTable(page: Page) {
  return page.getByRole('table')
}

test.describe('Pricing transparency (AC-014, AC-015)', () => {
  test('AI usage lists each call with duration and credits after an AI call', async ({
    page,
    context,
  }) => {
    await registerUser(context, page)
    await connectProvider(page)
    await oneChatTurn(page)

    await page.goto('/assistant/activity')
    const table = usageTable(page)
    await expect(table).toBeVisible({ timeout: 10_000 })
    const headerText = (await table.locator('thead th').allTextContents()).join(' ')
    expect(headerText).toContain('Duration')
    expect(headerText).toContain('Credits')
    expect(headerText).not.toContain('Base USD')
    expect(headerText).not.toContain('Total USD')
    expect(headerText).not.toContain('Markup')

    await expect(table.getByText('No activity logged yet.')).toHaveCount(0)
    expect(await table.locator('tbody tr').count()).toBeGreaterThanOrEqual(1)
  })

  test('AI usage shows a credits total for the page, never dollars', async ({ page, context }) => {
    await registerUser(context, page)
    await connectProvider(page)
    await oneChatTurn(page)

    await page.goto('/assistant/activity')
    const table = usageTable(page)
    await expect(table.getByText('No activity logged yet.')).toHaveCount(0, { timeout: 10_000 })
    await expect(table.locator('tfoot')).toBeVisible()
    const totalsText = (await table.locator('tfoot td').allTextContents()).join(' ')
    expect(totalsText).toContain('Total (this page)')
    expect(totalsText).not.toContain('$')
  })

  test('empty activity state shows placeholder message', async ({ page, context }) => {
    await registerUser(context, page)
    await page.goto('/assistant/activity')

    await expect(page.locator('text=No activity logged yet')).toBeVisible()
  })
})
