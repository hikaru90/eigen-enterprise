import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import BrainKnows from './brain-knows.svelte'

/**
 * "Your Brain knows 1,200 decisions" (board request): the retention line on
 * the assistant page, the count in the viewer's locale grouping, linking to
 * "What the brain knows", the list that holds them.
 */
describe('brain-knows.svelte', () => {
  it('shows the count with the locale’s digit grouping and links to What the brain knows', async () => {
    render(BrainKnows, { count: 1200 })
    const line = page.getByTestId('brain-knows')
    await expect
      .element(line)
      .toHaveTextContent(`Your Brain knows ${new Intl.NumberFormat().format(1200)} decisions`)
    // The list that holds them (plan/concept-memory-one-door.md §2.2), not the
    // module root, which lands on Tasks where the decisions are not listed.
    await expect.element(line).toHaveAttribute('href', '/m/memory/capture')
  })

  it('says one decision in the singular', async () => {
    render(BrainKnows, { count: 1 })
    await expect.element(page.getByTestId('brain-knows')).toHaveTextContent('Your Brain knows 1 decision')
  })

  it('says so plainly while it knows none yet', async () => {
    render(BrainKnows, { count: 0 })
    await expect
      .element(page.getByTestId('brain-knows'))
      .toHaveTextContent('Your Brain knows no decisions yet')
  })
})
