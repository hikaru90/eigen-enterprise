import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import PatternsCard from './patterns-card.svelte'

const base = { digestId: 'd1', createdAt: '2026-11-28T08:00:00Z', windowStart: '2026-11-21T08:00:00Z', windowEnd: '2026-11-28T08:00:00Z' }
const item = (id: string, kind: 'activity' | 'recurring', text: string) => ({
  id,
  kind,
  personId: 'anna',
  personName: 'Anna',
  module: 'drive',
  moduleLabel: 'Drive',
  count: 4,
  days: kind === 'recurring' ? 4 : 1,
  text,
})

describe('patterns-card', () => {
  it('shows each observation, recurring ones marked, and a refresh posting the page action', async () => {
    render(PatternsCard, {
      props: {
        patterns: {
          ...base,
          items: [item('anna:drive', 'recurring', 'Anna changed Drive files 4 times, on 4 days.'), item('ben:messages', 'activity', 'Ben posted 2 messages.')],
        },
      },
    })
    await expect.element(page.getByRole('heading', { name: "What's happening" })).toBeInTheDocument()
    expect((await page.getByTestId('dashboard-patterns-item').elements()).length).toBe(2)
    await expect.element(page.getByText('Anna changed Drive files 4 times, on 4 days.')).toBeInTheDocument()
    await expect.element(page.getByText('recurring')).toBeInTheDocument()
    const form = (await page.getByTestId('dashboard-patterns-refresh').element()).closest('form')
    expect(form?.getAttribute('action')).toBe('?/patternsRefresh')
  })

  it('says when no digest was written yet', async () => {
    render(PatternsCard, { props: { patterns: { digestId: null, createdAt: null, windowStart: null, windowEnd: null, items: [] } } })
    await expect.element(page.getByTestId('dashboard-patterns-empty')).toHaveTextContent('No digest yet')
  })

  it('says when nothing this person may see happened', async () => {
    render(PatternsCard, { props: { patterns: { ...base, items: [] } } })
    await expect.element(page.getByTestId('dashboard-patterns-empty')).toHaveTextContent('Nothing you can see happened')
  })
})
