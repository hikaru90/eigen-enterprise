import { createRawSnippet } from 'svelte'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { buildShellNav } from '$lib/shell/nav'
import AppShell from './app-shell.svelte'

const nav = buildShellNav(
  [
    { id: 'website', name: 'Website' },
    { id: 'email', name: 'Email' },
    { id: 'brand', name: 'Brand' },
    { id: 'repo', name: 'Repo' },
  ],
  new Map([
    ['website', true],
    ['email', true],
  ]),
)

const children = createRawSnippet(() => ({ render: () => '<p>Page body</p>' }))

function renderShell(pathname = '/overview') {
  return render(AppShell, {
    shell: { companyName: 'Kindred Digital Labs', nav },
    pathname,
    user: { name: 'Alex', email: 'alex@k.test' },
    children,
  })
}

describe('app-shell.svelte', () => {
  it('shows the company, the nav from the registry, the user and the page', async () => {
    renderShell()
    await expect.element(page.getByTestId('shell-company').first()).toHaveTextContent('Kindred Digital Labs')
    await expect.element(page.getByTestId('shell-nav-chat').first()).toHaveAttribute('href', '/')
    await expect.element(page.getByTestId('shell-nav-website').first()).toHaveAttribute('href', '/m/website')
    await expect.element(page.getByTestId('shell-nav-email').first()).toHaveAttribute('href', '/m/email')
    await expect.element(page.getByTestId('shell-nav-brand').first()).toHaveAttribute('href', '/brand')
    await expect.element(page.getByTestId('shell-nav-agent').first()).toHaveAttribute('href', '/runs')
    await expect.element(page.getByTestId('shell-nav-repo').first()).toHaveTextContent('Off')
    await expect.element(page.getByTestId('shell-nav-settings').first()).toHaveAttribute('href', '/settings')
    await expect.element(page.getByTestId('shell-user').first()).toHaveTextContent('Alex')
    await expect.element(page.getByText('Page body')).toBeInTheDocument()
  })

  it('marks the current page', async () => {
    renderShell('/m/website')
    await expect.element(page.getByTestId('shell-nav-website').first()).toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByTestId('shell-nav-overview').first()).not.toHaveAttribute('aria-current')
  })

  it('highlights exactly one entry: the agent for its internals, not Settings', async () => {
    renderShell('/settings/extensions')
    await expect.element(page.getByTestId('shell-nav-agent').first()).toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByTestId('shell-nav-settings').first()).not.toHaveAttribute('aria-current')
  })

  it('opens and closes the phone drawer from the top bar', async () => {
    renderShell()
    await expect.element(page.getByTestId('shell-drawer')).not.toBeInTheDocument()
    await page.getByTestId('shell-menu-toggle').click({ force: true })
    await expect.element(page.getByTestId('shell-drawer')).toBeInTheDocument()
    await page.getByTestId('shell-menu-toggle').click({ force: true })
    await expect.element(page.getByTestId('shell-drawer')).not.toBeInTheDocument()
  })
})
