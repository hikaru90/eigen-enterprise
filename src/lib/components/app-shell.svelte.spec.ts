import { createRawSnippet } from 'svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { SelfPresence } from '$lib/messages/self-presence.svelte'
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
  presence: SelfPresence | null = null,
  assistant = true,
) {
  return render(AppShell, {
    shell: { companyName: 'Kindred Digital Labs', companyLogo, capabilities, nav, assistant },
    pathname,
    user,
    presence,
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

  describe('with the Assistant switched off (round 5: off means off)', () => {
    afterEach(() => vi.unstubAllGlobals())

    it('has no assistant field, toggle or panel, and ⌘K opens nothing; the menu, Contribute and the page stay', async () => {
      const fetchSpy = vi.fn(async () => new Response('{}', { status: 500 }))
      vi.stubGlobal('fetch', fetchSpy)
      renderShell('/m/website', undefined, null, null, false)
      await expect.element(page.getByText('Page body')).toBeInTheDocument()
      const topbar = page.getByTestId('shell-topbar')
      await expect.element(topbar.getByTestId('contribute-trigger')).toBeInTheDocument()
      await expect.element(topbar.getByTestId('shell-menu-toggle')).toBeInTheDocument()
      await expect.element(page.getByTestId('assistant-bar')).not.toBeInTheDocument()
      await expect.element(page.getByTestId('assistant-toggle')).not.toBeInTheDocument()
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
      )
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
      await expect.element(page.getByTestId('assistant-panel')).not.toBeInTheDocument()
      // Nothing of the assistant is loaded or spoken to.
      const urls = fetchSpy.mock.calls.map((c) => String((c as unknown[])[0]))
      expect(
        urls.filter((u) => u.startsWith('/api/assistant') || u.startsWith('/api/chat')),
      ).toEqual([])
      // The Contribute button still sits at the top right.
      expect(topbar.element().lastElementChild?.matches('[data-testid="contribute-trigger"]')).toBe(
        true,
      )
    })
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

  describe('my status at the foot of the nav (Contribute e4ef6be1)', () => {
    const dnd = () => {
      const self = new SelfPresence({ fetch: async () => new Response(null, { status: 500 }) })
      self.receive({ userId: 'alex', status: 'dnd', doNotDisturb: true, lastSeenAt: null })
      return self
    }

    it('shows it bottom-left on every page while Messages is on', async () => {
      renderShell('/m/website', { name: 'Alex', email: 'alex@k.test' }, null, dnd())
      const sidebar = page.getByTestId('shell-sidebar')
      await expect.element(sidebar.getByTestId('shell-presence-label')).toHaveTextContent('Do not disturb')
      await expect.element(sidebar.getByTestId('shell-presence-dot')).toHaveAttribute('data-status', 'dnd')
      await expect.element(sidebar.getByTestId('shell-user')).toHaveTextContent('Alex')
      // The status sits in the footer, below the nav — not inside it.
      const footer = sidebar.getByTestId('shell-user-footer').element()
      expect(footer.contains(sidebar.getByTestId('shell-presence-trigger').element())).toBe(true)
      expect(footer.contains(sidebar.getByTestId('home-settings-trigger').element())).toBe(true)
    })

    it('on phones the menu button carries my status dot, and the drawer shows the status', async () => {
      renderShell('/m/website', { name: 'Alex', email: 'alex@k.test' }, null, dnd())
      await expect.element(page.getByTestId('shell-menu-presence')).toHaveAttribute('data-status', 'dnd')
      await expect.element(page.getByTestId('shell-menu-toggle')).toHaveAccessibleName('Open menu — your status: Do not disturb')
      await page.getByTestId('shell-menu-toggle').click({ force: true })
      await expect.element(page.getByTestId('shell-drawer').getByTestId('shell-presence-label')).toHaveTextContent('Do not disturb')
    })

    it('with Messages off there is no status at all (off means off)', async () => {
      renderShell('/m/website', { name: 'Alex', email: 'alex@k.test' }, null, null)
      await expect.element(page.getByTestId('shell-presence-trigger')).not.toBeInTheDocument()
      await expect.element(page.getByTestId('shell-menu-presence')).not.toBeInTheDocument()
      await expect.element(page.getByTestId('shell-menu-toggle')).toHaveAccessibleName('Open menu')
      await expect.element(page.getByTestId('shell-user').first()).toHaveTextContent('Alex')
    })
  })
})
