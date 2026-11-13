import { createRawSnippet } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AppShell from '$lib/components/app-shell.svelte'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import { buildShellNav } from '$lib/shell/nav'
import { HANDOFF_PENDING_KEY } from './handoff'
import { PANEL_DEFAULT_WIDTH, PANEL_MIN_WIDTH, PANEL_WIDTH_KEY, panelMaxWidth } from './panel-width'

/**
 * The one assistant (polish P-1) in the real shell: the top bar, ⌘K, the
 * panel opening on submit with the answer streaming in, its tabs, resizing
 * within bounds, Esc, a new conversation, and the provider-missing door.
 */

const capabilities = Object.fromEntries(CAPABILITIES.map((c) => [c, true])) as Capabilities
const nav = buildShellNav([{ id: 'website', name: 'Website' }], new Map([['website', true]]), capabilities)
const children = createRawSnippet(() => ({ render: () => '<p>Page body</p>' }))

type Call = { url: string; body: unknown }
let calls: Call[] = []
let conversation: Record<string, unknown>

function ndjson(lines: unknown[]): Response {
  return new Response(lines.map((l) => JSON.stringify(l)).join('\n') + '\n', {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

function stubFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (url === '/api/assistant/conversation') return Response.json(conversation)
      if (url === '/api/chat') {
        const body = JSON.parse(String(init?.body)) as { message?: string }
        return ndjson([
          { type: 'done', response: `You said: ${body.message ?? 'hello'}`, sessionId: 's-new' },
        ])
      }
      if (url === '/api/agent/runs') {
        return Response.json({
          runs: [
            {
              id: 7,
              conversationKey: 'orchestrator:s-1',
              agentId: 'orchestrator',
              title: 'Build me a bakery site',
              createdAt: '2026-11-03T10:00:00.000Z',
              updatedAt: '2026-11-04T09:30:00.000Z',
            },
          ],
        })
      }
      if (url === '/api/assistant/activity') {
        return Response.json({
          log: [
            {
              day: '2026-11-04',
              entries: [
                {
                  id: 'e1',
                  ts: '2026-11-04T09:00:00.000Z',
                  actor: 'Agent',
                  text: 'Published the Home page',
                  moduleLabel: 'Website',
                  outcome: 'done',
                },
              ],
            },
          ],
          modules: [],
          module: null,
        })
      }
      if (url === '/api/tts') return new Response('{}', { status: 500 })
      throw new Error(`unexpected fetch ${url}`)
    }),
  )
}

function renderShell() {
  return render(AppShell, {
    shell: { companyName: 'Kindred Digital Labs', companyLogo: null, capabilities, nav, assistant: true },
    pathname: '/m/website',
    user: { name: 'Alex', email: 'alex@k.test' },
    language: 'en',
    children,
  })
}

const barInput = () => page.getByTestId('assistant-bar-input')
const panel = () => page.getByTestId('assistant-panel')

beforeEach(() => {
  calls = []
  conversation = {
    sessionId: 's-1',
    turns: [{ role: 'assistant', content: 'Welcome back — your website next?' }],
    providerReady: true,
    isAdmin: false,
    approvalMode: null,
  }
  localStorage.removeItem(PANEL_WIDTH_KEY)
  sessionStorage.removeItem(HANDOFF_PENDING_KEY)
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assistant top bar', () => {
  it('sits in the shell with the ⌘K / Ctrl+K hint', async () => {
    renderShell()
    await expect.element(barInput()).toHaveAttribute('placeholder', 'Ask the assistant…')
    await expect.element(page.getByTestId('assistant-bar-shortcut')).toHaveTextContent(/K$/)
    await expect.element(page.getByText('Page body')).toBeInTheDocument()
    await expect.element(panel()).not.toBeInTheDocument()
  })

  it('⌘K and Ctrl+K focus it from anywhere', async () => {
    renderShell()
    await expect.element(barInput()).toBeInTheDocument()
    for (const mod of [{ metaKey: true }, { ctrlKey: true }]) {
      ;(document.activeElement as HTMLElement | null)?.blur()
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true, ...mod }))
      await expect.element(barInput()).toHaveFocus()
    }
  })

  it('submitting opens the panel and streams the answer into the current conversation', async () => {
    renderShell()
    await barInput().fill('What is new?')
    await barInput().element().closest('form')!.requestSubmit()
    await expect.element(panel()).toBeInTheDocument()
    await expect.element(page.getByText('Welcome back — your website next?')).toBeInTheDocument()
    await expect.element(page.getByText('You said: What is new?')).toBeInTheDocument()
    // The bar empties; the turn continued the stored session.
    await expect.element(barInput()).toHaveValue('')
    const chat = calls.find((c) => c.url === '/api/chat')
    expect(chat?.body).toEqual({ message: 'What is new?', sessionId: 's-1' })
  })
})

describe('assistant panel', () => {
  // A desktop window: 60% of it is well above the 320px minimum.
  beforeEach(async () => {
    await page.viewport(1400, 900)
  })

  async function openPanel() {
    renderShell()
    await page.getByTestId('assistant-toggle').click()
    await expect.element(panel()).toBeInTheDocument()
  }

  it('switches between Chat, History and Activity', async () => {
    await openPanel()
    await expect
      .element(page.getByTestId('assistant-tab-chat'))
      .toHaveAttribute('aria-selected', 'true')
    await page.getByTestId('assistant-tab-history').click()
    await expect
      .element(page.getByTestId('assistant-tab-history'))
      .toHaveAttribute('aria-selected', 'true')
    const item = page.getByTestId('assistant-history-item')
    await expect.element(item).toHaveTextContent('Build me a bakery site')
    // A conversation opens its linkable run view.
    await expect.element(item).toHaveAttribute('href', '/(nucleus)/assistant/[id]')
    await page.getByTestId('assistant-tab-activity').click()
    await expect
      .element(page.getByTestId('assistant-activity-entry'))
      .toHaveTextContent('Published the Home page')
    await expect
      .element(page.getByTestId('assistant-activity-all'))
      .toHaveAttribute('href', '/assistant/activity')
    await page.getByTestId('assistant-tab-chat').click()
    await expect.element(page.getByText('Welcome back — your website next?')).toBeInTheDocument()
  })

  it('resizes by dragging its left edge, within 320px and 60% of the window, and remembers it', async () => {
    await openPanel()
    const edge = page.getByTestId('assistant-resize')
    await expect.element(edge).toHaveAttribute('aria-valuenow', String(PANEL_DEFAULT_WIDTH))
    const el = edge.element()
    const drag = (fromX: number, toX: number) => {
      el.dispatchEvent(
        new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: fromX, bubbles: true }),
      )
      window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: toX }))
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: toX }))
    }
    expect(panelMaxWidth(window.innerWidth)).toBeGreaterThan(PANEL_DEFAULT_WIDTH + 40)
    // Wider by 40px.
    drag(800, 760)
    await expect.element(edge).toHaveAttribute('aria-valuenow', String(PANEL_DEFAULT_WIDTH + 40))
    // Far to the left: capped at 60% of the window.
    drag(800, -5000)
    const max = panelMaxWidth(window.innerWidth)
    await expect.element(edge).toHaveAttribute('aria-valuenow', String(max))
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe(String(max))
    // Far to the right: never narrower than the minimum.
    drag(0, 5000)
    await expect.element(edge).toHaveAttribute('aria-valuenow', String(PANEL_MIN_WIDTH))
    expect(localStorage.getItem(PANEL_WIDTH_KEY)).toBe(String(PANEL_MIN_WIDTH))
    // The keyboard resizes too.
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }))
    await expect.element(edge).toHaveAttribute('aria-valuenow', String(PANEL_MIN_WIDTH + 24))
  })

  it('opens at the remembered width', async () => {
    localStorage.setItem(PANEL_WIDTH_KEY, String(PANEL_MIN_WIDTH + 10))
    await openPanel()
    await expect
      .element(page.getByTestId('assistant-resize'))
      .toHaveAttribute('aria-valuenow', String(PANEL_MIN_WIDTH + 10))
  })

  it('Esc closes it, but not while typing in a field', async () => {
    await openPanel()
    await page.getByTestId('assistant-composer-input').click()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect.element(panel()).toBeInTheDocument()
    ;(document.activeElement as HTMLElement | null)?.blur()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect.element(panel()).not.toBeInTheDocument()
  })

  it('collapses with its close button', async () => {
    await openPanel()
    await page.getByTestId('assistant-close').click()
    await expect.element(panel()).not.toBeInTheDocument()
  })

  it('"New conversation" starts a fresh chat session', async () => {
    await openPanel()
    await expect.element(page.getByText('Welcome back — your website next?')).toBeInTheDocument()
    await page.getByTestId('assistant-new-conversation').click()
    await expect
      .element(page.getByText('Welcome back — your website next?'))
      .not.toBeInTheDocument()
    await expect.element(page.getByText('What do you need?')).toBeInTheDocument()
    await page.getByTestId('assistant-composer-input').fill('Fresh start')
    await page.getByRole('button', { name: 'Send' }).click()
    await expect.element(page.getByText('You said: Fresh start')).toBeInTheDocument()
    const chat = calls.filter((c) => c.url === '/api/chat').at(-1)
    // No session id: the server starts a new conversation.
    expect(chat?.body).toEqual({ message: 'Fresh start' })
  })

  it('without an AI provider it says so and links straight to the setup', async () => {
    conversation = { ...conversation, providerReady: false, turns: [] }
    await openPanel()
    await expect.element(page.getByTestId('assistant-provider-missing')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('assistant-provider-setup'))
      .toHaveAttribute('href', '/settings/llm')
  })

  it('streams the onboarding greeting into the panel, which opens on its own', async () => {
    sessionStorage.setItem(HANDOFF_PENDING_KEY, '1')
    renderShell()
    await expect.element(panel()).toBeInTheDocument()
    await expect.element(page.getByText('You said: hello')).toBeInTheDocument()
    const chat = calls.find((c) => c.url === '/api/chat')
    expect(chat?.body).toEqual({ bootstrap: true, onboardingHandoff: true, sessionId: 's-1' })
    expect(sessionStorage.getItem(HANDOFF_PENDING_KEY)).toBeNull()
  })
})
