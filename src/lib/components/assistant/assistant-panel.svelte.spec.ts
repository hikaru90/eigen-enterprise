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
      const formBody = init?.body instanceof FormData ? init.body : null
      calls.push({
        url,
        body: formBody ?? (init?.body ? JSON.parse(String(init.body)) : null),
      })
      if (url === '/api/assistant/conversation') return Response.json(conversation)
      if (url === '/api/assistant/attachments') {
        const file = formBody?.get('file')
        if (!(file instanceof File)) throw new Error('attachment upload without a file')
        if (file.name.endsWith('.docx')) {
          return Response.json(
            { error: `“${file.name}” isn't a file the assistant can read.` },
            { status: 415 },
          )
        }
        return Response.json({
          attachment: { name: file.name, kind: 'text', sizeBytes: file.size, text: await file.text() },
        })
      }
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
    children,
  })
}

const barInput = () => page.getByTestId('assistant-bar-input')
const panel = () => page.getByTestId('assistant-panel')
const spotlightBackdrop = () => page.getByTestId('assistant-spotlight-backdrop')

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
    // Asking closes the spotlight; the answer is in the panel.
    await expect.element(spotlightBackdrop()).not.toBeInTheDocument()
  })
})

describe('the spotlight (Contribute ccb12fab)', () => {
  const spotlight = () => page.getByTestId('assistant-spotlight')
  let opener: HTMLButtonElement

  beforeEach(() => {
    opener = document.createElement('button')
    opener.textContent = 'Somewhere on the page'
    document.body.append(opener)
  })
  afterEach(() => opener.remove())

  async function openFromOpener(): Promise<void> {
    opener.focus()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }))
    await expect.element(barInput()).toHaveFocus()
  }

  it('rests in the top bar as a pill, not a dialog', async () => {
    renderShell()
    await expect.element(barInput()).toBeInTheDocument()
    await expect.element(spotlight()).not.toHaveAttribute('role')
    await expect.element(spotlightBackdrop()).not.toBeInTheDocument()
  })

  it('⌘K floats it over a dimmed page as a modal dialog', async () => {
    renderShell()
    await openFromOpener()
    await expect.element(spotlight()).toHaveAttribute('role', 'dialog')
    await expect.element(spotlight()).toHaveAttribute('aria-modal', 'true')
    await expect.element(spotlight()).toHaveAccessibleName('Ask the assistant')
    await expect.element(spotlightBackdrop()).toBeInTheDocument()
    // The same input floats: ⌘K focused it, nothing else was mounted.
    expect(spotlight().element().contains(barInput().element())).toBe(true)
    await expect.element(page.getByTestId('assistant-spotlight-hint')).toHaveTextContent('Esc')
  })

  it('clicking the pill opens it too', async () => {
    renderShell()
    await barInput().click()
    await expect.element(spotlight()).toHaveAttribute('role', 'dialog')
  })

  it('Esc closes it and gives focus back; the panel stays as it was', async () => {
    renderShell()
    await openFromOpener()
    barInput().element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect.element(spotlightBackdrop()).not.toBeInTheDocument()
    await expect.element(spotlight()).not.toHaveAttribute('role')
    expect(document.activeElement).toBe(opener)
    await expect.element(panel()).not.toBeInTheDocument()
  })

  it('a click on the dimmed page closes it and gives focus back', async () => {
    renderShell()
    await openFromOpener()
    // Dispatched: component specs load no CSS, so the backdrop has no box to point at.
    spotlightBackdrop().element().dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
    spotlightBackdrop().element().dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await expect.element(spotlightBackdrop()).not.toBeInTheDocument()
    expect(document.activeElement).toBe(opener)
  })

  it('traps focus: Tab and Shift+Tab stay inside', async () => {
    renderShell()
    await openFromOpener()
    for (const shiftKey of [false, true, false]) {
      const tab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
      document.activeElement!.dispatchEvent(tab)
      expect(tab.defaultPrevented).toBe(true)
      expect(spotlight().element().contains(document.activeElement)).toBe(true)
    }
  })

  it('keeps the draft when it closes without asking', async () => {
    renderShell()
    await openFromOpener()
    await barInput().fill('half a thought')
    barInput().element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await expect.element(spotlightBackdrop()).not.toBeInTheDocument()
    await expect.element(barInput()).toHaveValue('half a thought')
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

  describe('the composer (Contribute: voice input, the speaker, attached documents)', () => {
    const chatbox = () => page.getByTestId('nucleus-chatbox')

    function chooseFiles(files: File[]): void {
      const input = page.getByTestId('assistant-attach-input').element() as HTMLInputElement
      const transfer = new DataTransfer()
      for (const file of files) transfer.items.add(file)
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    }

    it('reads attach, message, microphone, send — the mic directly left of send', async () => {
      await openPanel()
      const box = chatbox().element()
      const order = [
        'assistant-attach',
        'assistant-composer-input',
        'assistant-mic',
        'assistant-send',
      ].map((id) => box.querySelector(`[data-testid="${id}"]`))
      for (const el of order) expect(el).not.toBeNull()
      for (let i = 1; i < order.length; i++) {
        expect(
          order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy()
      }
      expect(order[2]!.nextElementSibling).toBe(order[3])
      await expect
        .element(page.getByRole('button', { name: 'Attach files' }))
        .toBeInTheDocument()
    })

    it('the speaker says what it is: a labelled "Read replies aloud" switch with its state', async () => {
      await openPanel()
      const toggle = page.getByRole('switch', { name: 'Read replies aloud: on' })
      await expect.element(toggle).toBeVisible()
      await expect.element(toggle).toHaveTextContent('Read replies aloud: On')
      await toggle.click()
      await expect
        .element(page.getByRole('switch', { name: 'Read replies aloud: off' }))
        .toBeInTheDocument()
      localStorage.removeItem('ee-voice')
    })

    it('an attached file shows as a chip, goes with the message, and stays on the sent message', async () => {
      await openPanel()
      chooseFiles([new File(['Ship the bakery site.'], 'notes.md', { type: 'text/markdown' })])
      const pending = page.getByTestId('assistant-composer-attachment')
      await expect.element(pending).toHaveTextContent('notes.md')
      await page.getByTestId('assistant-composer-input').fill('Summarise this.')
      await page.getByTestId('assistant-send').click()

      const sent = page.getByTestId('assistant-message-attachment')
      await expect.element(sent).toHaveTextContent('notes.md')
      await expect.element(pending).not.toBeInTheDocument()
      const chat = calls.find((c) => c.url === '/api/chat')
      expect(chat?.body).toEqual({
        message: 'Summarise this.',
        attachments: [
          { name: 'notes.md', kind: 'text', sizeBytes: 21, text: 'Ship the bakery site.' },
        ],
        sessionId: 's-1',
      })
    })

    it('a file alone can be sent, and a chip can be removed before sending', async () => {
      await openPanel()
      const send = page.getByTestId('assistant-send')
      await expect.element(send).toBeDisabled()
      chooseFiles([new File(['a'], 'a.txt'), new File(['b'], 'b.txt')])
      await expect.element(page.getByText('b.txt')).toBeInTheDocument()
      await page.getByRole('button', { name: 'Remove a.txt' }).click()
      await expect.element(page.getByText('a.txt')).not.toBeInTheDocument()
      await expect.element(send).toBeEnabled()
      await send.click()
      await expect.element(page.getByTestId('assistant-message-attachment')).toHaveTextContent('b.txt')
      const chat = calls.find((c) => c.url === '/api/chat')
      expect(chat?.body).toMatchObject({ message: '', attachments: [{ name: 'b.txt' }] })
    })

    it('a file the assistant cannot read is refused in plain words', async () => {
      await openPanel()
      chooseFiles([new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], 'brief.docx')])
      await expect
        .element(page.getByTestId('assistant-attachment-error'))
        .toHaveTextContent('“brief.docx” isn\'t a file the assistant can read.')
      await expect.element(page.getByTestId('assistant-composer-attachment')).not.toBeInTheDocument()
    })

    it('a saved message shows its attached files', async () => {
      conversation = {
        ...conversation,
        turns: [
          {
            role: 'user',
            content: 'Summarise this.',
            attachments: [{ name: 'q3.pdf', kind: 'pdf', sizeBytes: 1_258_291 }],
          },
        ],
      }
      await openPanel()
      const chip = page.getByTestId('assistant-message-attachment')
      await expect.element(chip).toHaveTextContent('q3.pdf')
      await expect.element(chip).toHaveTextContent('1.2 MB')
    })
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
