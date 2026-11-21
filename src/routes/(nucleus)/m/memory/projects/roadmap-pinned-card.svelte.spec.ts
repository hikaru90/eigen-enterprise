import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import RoadmapPinnedCard from './roadmap-pinned-card.svelte'

describe('Memory › Projects: the pinned Roadmap card (Contribute 6b5eda9f)', () => {
  it('says what the roadmap is and why it is pinned, and links to the board', async () => {
    render(RoadmapPinnedCard, {
      roadmap: { planned: 3, inProgress: 1, shipped: 5, building: ['Office files'] },
    })
    const card = page.getByTestId('project-card-roadmap')
    await expect.element(card).toHaveAttribute('href', '/m/memory/projects/roadmap')
    await expect.element(card).toHaveTextContent(/Roadmap/)
    await expect
      .element(page.getByTestId('roadmap-card-purpose'))
      .toHaveTextContent(
        "The company's plan: what is planned, being built and shipped. Pinned for everyone because it is the one project the whole company shares; it can't be unpinned.",
      )
    await expect.element(card).toHaveTextContent(/3 planned/)
    await expect.element(card).toHaveTextContent(/Building: Office files/)
  })
})
