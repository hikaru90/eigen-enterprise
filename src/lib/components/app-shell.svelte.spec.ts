import { createRawSnippet } from 'svelte'
import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { buildShellNav } from '$lib/shell/nav'
import AppShell from './app-shell.svelte'

const capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as Capabilities

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
  capabilities,
)

const children = createRawSnippet(() => ({ render: () => '<p>Page body</p>' }))

function renderShell(
  pathname = '/m/website',
  user: { name: string; email: string; image?: string | null } = {
    name: 'Alex',
    email: 'alex@k.test',
  },
  companyLogo: string | null = null,
) {
  return render(AppShell, {
    shell: { companyName: 'Kindred Digital Labs', companyLogo, capabilities, nav },
    pathname,
    user,
    language: 'en',
    children,
  })
}

describe('app-shell.svelte', () => {
  it('shows the company, the nav from the registry, the user and the page', async () => {
    renderShell()
    await expect.element(page.getByTestId('shell-company').first()).toHaveTextContent('Kindred Digital Labs')
    await expect.element(page.getByTestId('shell-company-link').first()).toHaveAttribute('href', '/')
    await expect.element(page.getByTestId('shell-nav-website').first()).toHaveAttribute('href', '/m/website')
    await expect.element(page.getByTestId('shell-nav-email').first()).toHaveAttribute('href', '/m/email')
    await expect.element(page.getByTestId('shell-nav-brand').first()).toHaveAttribute('href', '/brand')
    await expect.element(page.getByTestId('shell-nav-repo').first()).toHaveTextContent('Off')
    await expect.element(page.getByTestId('shell-nav-settings').first()).toHaveAttribute('href', '/settings')
    await expect.element(page.getByTestId('shell-user').first()).toHaveTextContent('Alex')
    await expect.element(page.getByText('Page body')).toBeInTheDocument()
  })

  it('has no Assistant, Overview or Agent entry (the top bar and the company badge replace them)', async () => {
    renderShell()
    for (const id of ['chat', 'overview', 'agent']) {
      await expect.element(page.getByTestId(`shell-nav-${id}`)).not.toBeInTheDocument()
    }
    await expect.element(page.getByTestId('assistant-bar-input')).toBeInTheDocument()
  })

  it('has the Contribute button at the top right of the top bar, opening the proposal composer', async () => {
    renderShell()
    const topbar = page.getByTestId('shell-topbar')
    const trigger = topbar.getByTestId('contribute-trigger')
    await expect.element(trigger).toHaveAccessibleName('Contribute: propose an improvement')
    const bar = topbar.element()
    expect(bar.lastElementChild?.matches('[data-testid="contribute-trigger"]')).toBe(true)
    await trigger.click()
    await expect.element(page.getByTestId('contribute-input')).toBeInTheDocument()
  })

  it('marks the current page', async () => {
    renderShell('/m/website')
    await expect.element(page.getByTestId('shell-nav-website').first()).toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByTestId('shell-company-link').first()).not.toHaveAttribute('aria-current')
  })

  it('the company badge is the dashboard link, current on /', async () => {
    renderShell('/')
    await expect.element(page.getByTestId('shell-company-link').first()).toHaveAttribute('aria-current', 'page')
    await expect.element(page.getByTestId('shell-nav-website').first()).not.toHaveAttribute('aria-current')
  })

  it('shows the company logo at the top left once one is set, else the initial', async () => {
    renderShell('/', undefined, '/api/company/logo/abc')
    await expect.element(page.getByTestId('shell-company-logo').first()).toHaveAttribute('src', '/api/company/logo/abc')
    await expect.element(page.getByTestId('shell-company-badge')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('shell-company').first()).toHaveTextContent('Kindred Digital Labs')
  })

  it('shows the initial badge without a logo', async () => {
    renderShell('/')
    await expect.element(page.getByTestId('shell-company-badge').first()).toHaveTextContent('K')
    await expect.element(page.getByTestId('shell-company-logo')).not.toBeInTheDocument()
  })

  it("shows the member's picture when there is one, else the initial", async () => {
    renderShell('/m/website', { name: 'Alex', email: 'alex@k.test', image: '/api/profile/picture/abc' })
    await expect.element(page.getByTestId('shell-user-avatar').first()).toHaveAttribute('src', '/api/profile/picture/abc')
    await expect.element(page.getByTestId('shell-user-initial')).not.toBeInTheDocument()
  })

  it('shows the initial without a picture', async () => {
    renderShell()
    await expect.element(page.getByTestId('shell-user-initial').first()).toHaveTextContent('A')
    await expect.element(page.getByTestId('shell-user-avatar')).not.toBeInTheDocument()
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
