import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { foldAiUsage, type AiUsageRow } from '$lib/ai-usage/overview'
import { AI_PRODUCT_IDS } from '$lib/ai-usage/tasks'
import AiUsageOverview from './ai-usage-overview.svelte'

/**
 * Settings → AI usage: a view of settings.ai_usage_overview — totals, the daily bars and the
 * three tables with their breakdowns. Amounts and counts only.
 */

const row = (over: Partial<AiUsageRow>): AiUsageRow => ({
  userId: 'u-mia',
  name: 'Mia',
  kind: 'person',
  task: 'brain.retrieval_rerank',
  model: 'm/one',
  day: '2026-11-26',
  costUsd: 1.5,
  calls: 3,
  promptTokens: 1000,
  completionTokens: 200,
  cachedTokens: 400,
  eigenInferenceUsd: 0,
  ...over,
})

const overview = foldAiUsage(
  [row({}), row({ userId: 'u-cw', name: 'Marketing', kind: 'coworker', task: 'coworkers.turn', model: null, costUsd: 0.5, calls: 2 })],
  { from: '2026-11-25', to: '2026-11-27' },
)

const rowOf = (testid: string) => page.getByTestId(testid)

describe('ai-usage-overview.svelte', () => {
  it('shows the totals, a bar for every day and the period switch', async () => {
    render(AiUsageOverview, { overview, period: '7' })
    await expect.element(page.getByTestId('ai-usage-spend')).toHaveTextContent('$2.00')
    await expect.element(page.getByTestId('ai-usage-calls')).toHaveTextContent('5')
    await expect.element(page.getByTestId('ai-usage-tokens')).toHaveTextContent('2.4k tokens')
    expect(page.getByTestId('ai-usage-day').elements()).toHaveLength(3)
    await expect.element(page.getByRole('link', { name: '7 days' })).toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByRole('link', { name: '90 days' })).toHaveAttribute('href', '/settings/ai-usage?period=90')
  })

  it('lists every product, also at zero, and opens a product into its tasks', async () => {
    render(AiUsageOverview, { overview, period: '7' })
    expect(page.getByTestId('ai-usage-product-row').elements()).toHaveLength(AI_PRODUCT_IDS.length + 1)
    expect(page.getByText('Ranking search results').elements()).toHaveLength(0)
    await rowOf('ai-usage-products').getByRole('button', { name: 'Brain' }).click()
    await expect.element(page.getByText('Ranking search results')).toBeVisible()
  })

  it('shows each person and co-worker with their products behind their row', async () => {
    render(AiUsageOverview, { overview, period: '7' })
    const people = rowOf('ai-usage-people')
    await expect.element(people.getByText('AI co-worker', { exact: true })).toBeVisible()
    await people.getByRole('button', { name: 'Mia' }).click()
    await expect.element(people.getByTestId('ai-usage-sub-row')).toHaveTextContent('Brain')
  })

  it('names the models, a call without a recorded one as such', async () => {
    render(AiUsageOverview, { overview, period: '7' })
    await expect.element(rowOf('ai-usage-models').getByText('m/one')).toBeVisible()
    await expect.element(rowOf('ai-usage-models').getByText('Not recorded')).toBeVisible()
  })

  it('self-hosted: USD as logged, no billing line', async () => {
    render(AiUsageOverview, { overview, period: '7' })
    await expect.element(page.getByTestId('ai-usage-spend')).toHaveTextContent('$2.00')
    expect(page.getByTestId('ai-usage-billing').elements()).toHaveLength(0)
    expect(page.getByTestId('ai-usage-provider-usd').elements()).toHaveLength(0)
  })

  it('hosted with eigenInference: € invoiced everywhere, the provider USD beside it, the rate and its day stated', async () => {
    const billing = { currency: 'EUR' as const, markup: 1.2, usdToEur: 0.95, rateDay: '2026-11-27' }
    const hosted = foldAiUsage(
      [row({ costUsd: 1.2, eigenInferenceUsd: 1 }), row({ userId: 'u-cw', name: 'Marketing', kind: 'coworker', task: 'coworkers.turn', model: null, costUsd: 0.6, eigenInferenceUsd: 0.5, calls: 2 })],
      { from: '2026-11-25', to: '2026-11-27' },
      billing,
    )
    render(AiUsageOverview, { overview: hosted, period: '7' })
    await expect.element(page.getByTestId('ai-usage-spend')).toHaveTextContent('€1.71')
    await expect.element(page.getByTestId('ai-usage-provider-usd')).toHaveTextContent('$1.50 provider cost')
    await expect.element(page.getByTestId('ai-usage-billing')).toHaveTextContent('provider cost × 1.2, at 1 USD = 0.95 EUR (rate of 2026-11-27)')
    const brain = rowOf('ai-usage-products').getByTestId('ai-usage-product-row').filter({ hasText: 'Brain' })
    await expect.element(brain).toHaveTextContent('€1.14')
    await expect.element(brain).toHaveTextContent('$1.00')
    await expect.element(rowOf('ai-usage-products').getByText('Invoiced', { exact: true })).toBeVisible()
    await expect.element(page.getByRole('button', { name: /Nov 26: €1\.71/ })).toBeVisible()
  })

  it('says so when the period has no calls', async () => {
    render(AiUsageOverview, { overview: foldAiUsage([], { from: '2026-11-21', to: '2026-11-27' }), period: '7' })
    await expect.element(page.getByTestId('ai-usage-empty')).toBeVisible()
  })
})
