import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ModuleCard from './module-card.svelte'

const module = {
  id: 'website',
  name: 'Website',
  description: 'The company site.',
  active: true,
  results: [],
  counts: [
    { label: 'Published', value: 2 },
    { label: 'Drafts', value: 1 },
  ],
  note: null,
}

describe('module-card.svelte', () => {
  it('links to the module page and shows its counts', async () => {
    render(ModuleCard, { module })
    await expect.element(page.getByRole('link')).toHaveAttribute('href', '/m/website')
    await expect.element(page.getByText('Website')).toBeInTheDocument()
    await expect.element(page.getByTestId('module-card-count-Published')).toHaveTextContent('2')
    await expect.element(page.getByTestId('module-card-count-Drafts')).toHaveTextContent('1')
  })

  it('shows the note when there are no counts', async () => {
    render(ModuleCard, { module: { ...module, counts: [], note: 'Only the owner can see these results.' } })
    await expect.element(page.getByText('Only the owner can see these results.')).toBeInTheDocument()
  })
})
