import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { AGENT_TABS } from '$lib/shell/area-nav'
import PageHeader from './page-header.svelte'

describe('page-header: the one page frame', () => {
  it('renders the title as h1, the description, a dotted status pill and tabs below', async () => {
    render(PageHeader, {
      props: {
        title: 'Agent',
        description: 'What the agent did.',
        status: { label: 'Active', on: true },
        tabs: AGENT_TABS,
        current: 'activity',
        navTestId: 'agent-area-nav',
        tabTestId: (id: string) => `agent-nav-${id}`,
      },
    })
    await expect.element(page.getByRole('heading', { level: 1, name: 'Agent' })).toBeVisible()
    await expect
      .element(page.getByTestId('page-description'))
      .toHaveTextContent('What the agent did.')
    await expect.element(page.getByTestId('module-status')).toHaveTextContent('Active')
    await expect
      .element(page.getByTestId('agent-nav-activity'))
      .toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByTestId('agent-nav-runs')).not.toHaveAttribute('aria-current')
    await expect
      .element(page.getByTestId('agent-nav-roadmap'))
      .toHaveAttribute('href', '/agent/roadmap')
  })

  it('omits the optional parts', async () => {
    render(PageHeader, { props: { title: 'Overview' } })
    await expect.element(page.getByRole('heading', { level: 1, name: 'Overview' })).toBeVisible()
    await expect.element(page.getByTestId('page-description')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('module-status')).not.toBeInTheDocument()
    await expect.element(page.getByRole('navigation')).not.toBeInTheDocument()
  })
})
