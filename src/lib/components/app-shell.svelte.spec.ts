import { createRawSnippet } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { SelfPresence } from '$lib/messages/self-presence.svelte'
import { buildShellNav } from '$lib/shell/nav'
import { SIDEBAR_COLLAPSED_KEY } from '$lib/shell/sidebar-pref'
import AppShell from './app-shell.svelte'
import { PANEL_SESSION_KEY } from './assistant/panel-session'

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
    children,
  })
}

describe('app-shell.svelte', () => {
  beforeEach(() => {
    localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
    sessionStorage.removeItem(PANEL_SESSION_KEY)
  })

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

    it('has no assistant field, toggle or panel, and ⌘K opens nothing; the menu, Make a wish and the page stay', async () => {
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
      // The Make a wish button still sits at the top right.
      expect(topbar.element().lastElementChild?.matches('[data-testid="contribute-trigger"]')).toBe(
        true,
      )
    })
  })

  it('has the Make a wish button at the top right of the top bar, opening the wish composer', async () => {
    renderShell()
    const topbar = page.getByTestId('shell-topbar')
    const trigger = topbar.getByTestId('contribute-trigger')
    await expect.element(trigger).toHaveAccessibleName('Make a wish: propose an improvement')
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

  describe('scrolling sideways pulls in the sides (owner, 2026-11-23)', () => {
    /** A one-finger flick across the element, as touch events. */
    const flick = async (testid: string, from: number, to: number) => {
      const el = (await page.getByTestId(testid).elements())[0]
      const at = (x: number) => new Touch({ identifier: 7, target: el, clientX: x, clientY: 400 })
      const steps = [['touchstart', from], ['touchmove', (from + to) / 2], ['touchend', to]] as const
      for (const [type, x] of steps) {
        const t = at(x)
        el.dispatchEvent(
          new TouchEvent(type, { touches: type === 'touchend' ? [] : [t], changedTouches: [t], bubbles: true, cancelable: true }),
        )
      }
    }
    /** A trackpad gesture over the element: a burst of wheel events. */
    const scroll = async (testid: string, deltaX: number, deltaY = 0) => {
      const el = (await page.getByTestId(testid).elements())[0]
      const events = [0, 1, 2, 3].map(() => new WheelEvent('wheel', { deltaX, deltaY, bubbles: true, cancelable: true }))
      for (const e of events) el.dispatchEvent(e)
      // A pause ends the gesture.
      await new Promise((r) => setTimeout(r, 300))
      return events
    }

    it('on phones a flick right anywhere opens the drawer, left closes it; left again opens the assistant, right closes it', async () => {
      renderShell()
      await flick('shell-content', 60, 300)
      await expect.element(page.getByTestId('shell-drawer')).toBeInTheDocument()
      await flick('shell-drawer', 240, 40)
      await expect.element(page.getByTestId('shell-drawer')).not.toBeInTheDocument()
      await flick('shell-content', 300, 60)
      await expect.element(page.getByTestId('assistant-panel')).toBeInTheDocument()
      await expect.element(page.getByTestId('shell-drawer')).not.toBeInTheDocument()
      await flick('assistant-panel', 60, 300)
      await expect.element(page.getByTestId('assistant-panel')).not.toBeInTheDocument()
    })

    it('leaves vertical flicks and a container that scrolls sideways alone', async () => {
      renderShell()
      const content = (await page.getByTestId('shell-content').elements())[0]
      content.insertAdjacentHTML(
        'beforeend',
        '<div data-testid="wide" style="overflow-x:auto;width:200px"><div style="width:800px;height:40px"></div></div>',
      )
      await flick('wide', 300, 60)
      await expect.element(page.getByTestId('assistant-panel')).not.toBeInTheDocument()
      // Scrolled to its start, it no longer takes a flick right: that one opens the drawer.
      await flick('wide', 60, 300)
      await expect.element(page.getByTestId('shell-drawer')).toBeInTheDocument()
    })

    it('leaves touches on an element with its own swipe alone (the calendar pages by swiping)', async () => {
      renderShell()
      const content = (await page.getByTestId('shell-content').elements())[0]
      content.insertAdjacentHTML('beforeend', '<div data-testid="own" data-own-swipe style="height:40px"></div>')
      await flick('own', 60, 300)
      await flick('own', 300, 60)
      await expect.element(page.getByTestId('shell-drawer')).not.toBeInTheDocument()
      await expect.element(page.getByTestId('assistant-panel')).not.toBeInTheDocument()
    })

    it('on desktop a horizontal trackpad scroll opens the assistant and the collapsed sidebar', async () => {
      await page.viewport(1280, 800)
      try {
        renderShell()
        // Vertical scrolling is never taken (nor prevented).
        const vertical = await scroll('shell-content', 0, 40)
        expect(vertical.some((e) => e.defaultPrevented)).toBe(false)
        await expect.element(page.getByTestId('assistant-panel')).not.toBeInTheDocument()

        // Fingers left (deltaX > 0): the assistant comes in; the browser's back/forward swipe is held off.
        const left = await scroll('shell-content', 40)
        expect(left.every((e) => e.defaultPrevented)).toBe(true)
        await expect.element(page.getByTestId('assistant-panel')).toBeInTheDocument()
        // Fingers right: the assistant goes away; the docked sidebar stays.
        await scroll('shell-content', -40)
        await expect.element(page.getByTestId('assistant-panel')).not.toBeInTheDocument()
        await scroll('shell-content', -40)
        await expect.element(page.getByTestId('shell-sidebar')).toBeInTheDocument()

        // Collapsed, a scroll right brings the sidebar back.
        await page.getByTestId('shell-sidebar-toggle').click()
        await expect.element(page.getByTestId('shell-sidebar')).not.toBeInTheDocument()
        await scroll('shell-content', -40)
        await expect.element(page.getByTestId('shell-sidebar')).toBeInTheDocument()
      } finally {
        await page.viewport(414, 896)
      }
    })
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

  describe('one scroll container for the page (Contribute df2f73e7)', () => {
    const scrolls = (el: Element) => /(^|\s)overflow(-[xy])?-(auto|scroll)(\s|$)/.test(el.className)

    it('the frame is exactly the viewport and clips; only the content column scrolls', async () => {
      renderShell()
      await expect.element(page.getByText('Page body')).toBeInTheDocument()
      const shell = page.getByTestId('app-shell').element()
      // Fixed to the viewport and clipping — and positioned, so absolutely
      // placed descendants (sr-only labels, menus) are clipped by it instead
      // of stretching the document below the frame.
      for (const c of ['relative', 'h-dvh', 'overflow-hidden']) expect(shell.classList).toContain(c)
      const content = page.getByTestId('shell-content').element()
      for (const c of ['relative', 'min-h-0', 'flex-1', 'overflow-y-auto']) {
        expect(content.classList).toContain(c)
      }
      // Every flex parent between the frame and the content may shrink and clips.
      for (const id of ['shell-column', 'shell-panel']) {
        const el = page.getByTestId(id).element()
        for (const c of ['min-h-0', 'flex-1']) expect(el.classList).toContain(c)
        expect(scrolls(el)).toBe(false)
      }
      // Nothing else in the frame scrolls but the nav list itself.
      const scrollers = [shell, ...shell.querySelectorAll('*')].filter(scrolls)
      expect(scrollers.map((el) => el.getAttribute('data-testid') ?? el.tagName.toLowerCase())).toEqual([
        'shell-nav-scroll',
        'shell-content',
      ])
    })
  })

  describe('the sidebar toggle (Contribute ff714496)', () => {
    const toggle = () => page.getByTestId('shell-sidebar-toggle')
    const backslash = (mod: { metaKey?: boolean; ctrlKey?: boolean }) =>
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '\\', code: 'Backslash', bubbles: true, ...mod }))

    it('collapses and expands the desktop sidebar and remembers the choice', async () => {
      renderShell()
      await expect.element(page.getByTestId('shell-sidebar')).toBeInTheDocument()
      await expect.element(toggle()).toHaveAccessibleName('Collapse sidebar')
      await expect.element(toggle()).toHaveAttribute('aria-expanded', 'true')
      await toggle().click()
      await expect.element(page.getByTestId('shell-sidebar')).not.toBeInTheDocument()
      await expect.element(toggle()).toHaveAccessibleName('Expand sidebar')
      await expect.element(toggle()).toHaveAttribute('aria-expanded', 'false')
      expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('1')
      await expect.element(page.getByText('Page body')).toBeInTheDocument()
      await toggle().click()
      await expect.element(page.getByTestId('shell-sidebar')).toBeInTheDocument()
      expect(localStorage.getItem(SIDEBAR_COLLAPSED_KEY)).toBe('0')
    })

    it('opens collapsed when the viewer collapsed it before', async () => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
      renderShell()
      await expect.element(toggle()).toHaveAccessibleName('Expand sidebar')
      await expect.element(page.getByTestId('shell-sidebar')).not.toBeInTheDocument()
    })

    it('⌘\\ and Ctrl+\\ toggle it from anywhere', async () => {
      renderShell()
      await expect.element(page.getByTestId('shell-sidebar')).toBeInTheDocument()
      backslash({ metaKey: true })
      await expect.element(page.getByTestId('shell-sidebar')).not.toBeInTheDocument()
      backslash({ ctrlKey: true })
      await expect.element(page.getByTestId('shell-sidebar')).toBeInTheDocument()
    })

    it('the phone menu is untouched: collapsed or not, the drawer opens with the nav', async () => {
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, '1')
      renderShell()
      await page.getByTestId('shell-menu-toggle').click({ force: true })
      await expect.element(page.getByTestId('shell-drawer').getByTestId('shell-nav-website')).toBeInTheDocument()
    })
  })
})

describe('navigating keeps the assistant (board de821eda)', () => {
  const conversation = {
    sessionId: 's-1',
    turns: [{ role: 'assistant', content: 'Welcome back — your website next?' }],
    providerReady: true,
    isAdmin: false,
    approvalMode: null,
  }
  const panel = () => page.getByTestId('assistant-panel')

  beforeEach(() => {
    localStorage.removeItem(SIDEBAR_COLLAPSED_KEY)
    sessionStorage.removeItem(PANEL_SESSION_KEY)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url === '/api/assistant/conversation') return Response.json(conversation)
        if (url === '/api/agent/runs') return Response.json({ runs: [] })
        throw new Error(`unexpected fetch ${url}`)
      }),
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    sessionStorage.removeItem(PANEL_SESSION_KEY)
  })

  it('moving to another page keeps the same open panel and its conversation (client-side navigation)', async () => {
    const shell = renderShell('/m/website')
    await page.getByTestId('assistant-toggle').click()
    await expect.element(panel().getByText('Welcome back — your website next?')).toBeInTheDocument()
    const before = (await panel().elements())[0]
    await shell.rerender({ pathname: '/m/email' })
    await expect.element(page.getByTestId('shell-nav-email').first()).toHaveAttribute('aria-current', 'page')
    expect((await panel().elements())[0]).toBe(before)
    await expect.element(panel().getByText('Welcome back — your website next?')).toBeInTheDocument()
  })

  it('a full page load brings the panel back open on its tab, with the conversation', async () => {
    const first = renderShell('/m/website')
    await page.getByTestId('assistant-toggle').click()
    await page.getByTestId('assistant-tab-history').click()
    await expect.element(page.getByTestId('assistant-tab-history')).toHaveAttribute('aria-selected', 'true')
    first.unmount()
    await expect.element(panel()).not.toBeInTheDocument()

    renderShell('/m/email')
    await expect.element(panel()).toBeInTheDocument()
    await expect.element(page.getByTestId('assistant-tab-history')).toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('assistant-tab-chat').click()
    await expect.element(panel().getByText('Welcome back — your website next?')).toBeInTheDocument()
  })

  it('a panel closed before the load stays closed', async () => {
    const first = renderShell('/m/website')
    await page.getByTestId('assistant-toggle').click()
    await expect.element(panel()).toBeInTheDocument()
    await page.getByTestId('assistant-close').click()
    await expect.element(panel()).not.toBeInTheDocument()
    first.unmount()

    renderShell('/m/email')
    await expect.element(page.getByText('Page body')).toBeInTheDocument()
    await expect.element(panel()).not.toBeInTheDocument()
  })

  it('a link in a reply to a page of the app opens in the same tab; another site in a new one', async () => {
    conversation.turns = [
      { role: 'assistant', content: 'Open [the website module](/m/website) or [the docs](https://elsewhere.test/docs).' },
    ]
    renderShell('/m/email')
    await page.getByTestId('assistant-toggle').click()
    const inApp = panel().getByRole('link', { name: 'the website module' })
    await expect.element(inApp).toHaveAttribute('href', '/m/website')
    await expect.element(inApp).not.toHaveAttribute('target')
    await expect
      .element(panel().getByRole('link', { name: 'the docs' }))
      .toHaveAttribute('target', '_blank')
  })
})
