import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ModuleCard from './module-card.svelte'

const module = {
  id: 'website',
  name: 'Website',
  description: 'The company site.',
  active: true,
  resultsTitle: 'Pages',
  results: [],
  counts: [
    { label: 'Published', value: 2 },
    { label: 'Drafts', value: 1 },
  ],
  note: null,
}

describe('module-card.svelte', () => {
  it('links to the module page and shows its counts', async () => {
    render(ModuleCard, { module, href: '/m/website' })
    await expect.element(page.getByRole('link')).toHaveAttribute('href', '/m/website')
    await expect.element(page.getByText('Website')).toBeInTheDocument()
    await expect.element(page.getByTestId('module-card-count-Published')).toHaveTextContent('2')
    await expect.element(page.getByTestId('module-card-count-Drafts')).toHaveTextContent('1')
  })

  it('shows the note when there are no counts', async () => {
    render(ModuleCard, { module: { ...module, counts: [], note: 'Only the owner can see these results.' }, href: '/m/website' })
    await expect.element(page.getByText('Only the owner can see these results.')).toBeInTheDocument()
  })

  it("wears the part's website colour on its mark, on a neutral stage", async () => {
    render(ModuleCard, { module, href: '/m/website' })
    await expect.element(page.getByTestId('module-card')).toHaveClass(/\bstage-ink\b/)
    await expect.element(page.getByTestId('module-card-mark')).toHaveClass(/\bmark-blue\b/)
  })

  it('gives a part without a colour a neutral mark', async () => {
    render(ModuleCard, { module: { ...module, id: 'some-new-module', name: 'New' }, href: null })
    await expect.element(page.getByTestId('module-card')).toHaveClass(/\bstage-white\b/)
    await expect.element(page.getByTestId('module-card-mark')).toHaveClass(/\bmark-ink\b/)
  })

  it('is no link when the person cannot open the module page (no 403 behind a card)', async () => {
    render(ModuleCard, { module, href: null })
    await expect.element(page.getByTestId('module-card')).toBeInTheDocument()
    await expect.element(page.getByRole('link')).not.toBeInTheDocument()
    await expect.element(page.getByText('Website')).toBeInTheDocument()
  })
})
