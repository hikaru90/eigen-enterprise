import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import OverviewModule from './overview-module.svelte'

const base = { id: 'website', name: 'Website', description: 'The company site.', results: [], note: null }

describe('overview-module.svelte', () => {
  it('shows an active module with linked results', async () => {
    render(OverviewModule, {
      module: {
        ...base,
        active: true,
        results: [
          { label: 'Founding journey', detail: 'In progress', href: null },
          { label: 'Home', detail: 'Draft', href: 'http://localhost/site/home' },
        ],
      },
    })
    await expect.element(page.getByTestId('overview-module-state')).toHaveTextContent('Active')
    await expect.element(page.getByText('Results')).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'Home' }))
      .toHaveAttribute('href', 'http://localhost/site/home')
    await expect.element(page.getByText('In progress')).toBeInTheDocument()
  })

  it('shows an inactive module without results', async () => {
    render(OverviewModule, { module: { ...base, active: false } })
    await expect.element(page.getByTestId('overview-module-state')).toHaveTextContent('Inactive')
    await expect.element(page.getByText('Results')).not.toBeInTheDocument()
  })

  it('shows the note when results are not available', async () => {
    render(OverviewModule, { module: { ...base, active: true, note: 'Preview link not available yet' } })
    await expect.element(page.getByTestId('overview-module-note')).toHaveTextContent('Preview link not available yet')
  })
})
