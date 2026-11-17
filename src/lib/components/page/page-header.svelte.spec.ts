import { createRawSnippet } from 'svelte'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { ASSISTANT_TABS } from '$lib/shell/area-nav'
import PageHeader from './page-header.svelte'

describe('page-header: the one page frame', () => {
  it('renders the title as h1, the description, a dotted status pill and tabs below', async () => {
    render(PageHeader, {
      props: {
        title: 'Assistant',
        description: 'What the assistant did.',
        status: { label: 'Active', on: true },
        tabs: ASSISTANT_TABS,
        current: 'activity',
        navTestId: 'assistant-area-nav',
        tabTestId: (id: string) => `assistant-nav-${id}`,
      },
    })
    await expect.element(page.getByRole('heading', { level: 1, name: 'Assistant' })).toBeVisible()
    await expect
      .element(page.getByTestId('page-description'))
      .toHaveTextContent('What the assistant did.')
    await expect.element(page.getByTestId('module-status')).toHaveTextContent('Active')
    await expect
      .element(page.getByTestId('assistant-nav-activity'))
      .toHaveAttribute('aria-current', 'page')
    await expect
      .element(page.getByTestId('assistant-nav-conversations'))
      .not.toHaveAttribute('aria-current')
    await expect
      .element(page.getByTestId('assistant-nav-activity'))
      .toHaveAttribute('href', '/assistant/activity')
  })

  it('omits the optional parts', async () => {
    render(PageHeader, { props: { title: 'Brand' } })
    await expect.element(page.getByRole('heading', { level: 1, name: 'Brand' })).toBeVisible()
    await expect.element(page.getByTestId('page-description')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('module-status')).not.toBeInTheDocument()
    await expect.element(page.getByRole('navigation')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('page-mark')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('page-info')).not.toBeInTheDocument()
  })

  it('puts the explanation behind a "?" next to the title, not on the page', async () => {
    const info = createRawSnippet(() => ({ render: () => '<p>Domains, mailboxes and senders live under Setup.</p>' }))
    render(PageHeader, { props: { title: 'Email', info } })
    await expect.element(page.getByText('Domains, mailboxes and senders')).not.toBeInTheDocument()
    const button = page.getByRole('button', { name: 'About Email' })
    await expect.element(button).toBeVisible()
    await button.click()
    await expect
      .element(page.getByRole('dialog', { name: 'About Email' }))
      .toHaveTextContent('Domains, mailboxes and senders live under Setup.')
  })

  it('names the info button with infoLabel when given', async () => {
    const info = createRawSnippet(() => ({ render: () => '<p>Who can see it.</p>' }))
    render(PageHeader, { props: { title: 'Memory', info, infoLabel: 'About Memory and who can see it' } })
    await expect
      .element(page.getByRole('button', { name: 'About Memory and who can see it' }))
      .toBeVisible()
  })

  it("shows the area's part mark in its website colour next to the title", async () => {
    render(PageHeader, { props: { title: 'Website', part: 'website' } })
    await expect.element(page.getByRole('heading', { level: 1, name: 'Website' })).toBeVisible()
    await expect.element(page.getByTestId('page-mark')).toHaveClass(/\bmark-blue\b/)
  })
})
