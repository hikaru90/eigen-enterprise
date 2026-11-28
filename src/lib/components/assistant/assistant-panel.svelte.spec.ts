import { createRawSnippet } from 'svelte'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { page as appPage } from '$app/state'
import { CAPABILITIES, type Capabilities } from '$lib/access/capabilities'
import AppShell from '$lib/components/app-shell.svelte'
import { buildShellNav } from '$lib/shell/nav'
import { FakeMediaRecorder, installVoiceDoubles } from '$lib/test/voice-doubles'
import { DICTATION_MISSING_MESSAGE } from '$lib/voice/dictation-readiness'
import { HANDOFF_PENDING_KEY } from './handoff'
import { PANEL_SESSION_KEY } from './panel-session'
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
/** The person's AI use today (GET /api/assistant/usage → settings.my_ai_usage); null: the read fails. */
let usageToday: Record<string, unknown> | null
/** Scripted /api/chat replies, one per request (empty: the echo reply below). */
let chatReplies: Array<(signal: AbortSignal | null | undefined) => Response> = []
/** Scripted /api/assistant/route answers (the one door), one per request; empty: a question (to the chat). */
let routeReplies: Array<() => Response> = []
/** What the speech-to-text endpoint hears in a dictation test. */
let voiceTranscript = ''

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
        body: formBody ?? (init?.body instanceof Blob ? init.body : init?.body ? JSON.parse(String(init.body)) : null),
      })
      if (url === '/api/assistant/conversation') return Response.json(conversation)
      if (url === '/api/assistant/usage') {
        return usageToday ? Response.json(usageToday) : new Response('{}', { status: 500 })
      }
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
      if (url === '/api/assistant/route') {
        const scripted = routeReplies.shift()
        if (scripted) return scripted()
        return Response.json({ outcome: 'chat', route: 'question', decisionId: 'd-q', confidence: 0.9, source: 'jev' })
      }
      if (url === '/api/chat') {
        const scripted = chatReplies.shift()
        if (scripted) return scripted(init?.signal)
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
      if (url === '/api/voice/transcribe') return Response.json({ transcript: voiceTranscript })
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
  chatReplies = []
  routeReplies = []
  conversation = {
    sessionId: 's-1',
    turns: [{ role: 'assistant', content: 'Welcome back — your website next?' }],
    providerReady: true,
    isAdmin: false,
    approvalMode: null,
  }
  usageToday = {
    role: 'member',
    capUsd: 0.5,
    capApplies: true,
    spentUsd: 0.1,
    remainingUsd: 0.4,
    resetsAt: '2026-11-24T00:00:00.000Z',
  }
  localStorage.removeItem(PANEL_WIDTH_KEY)
  sessionStorage.removeItem(HANDOFF_PENDING_KEY)
  sessionStorage.removeItem(PANEL_SESSION_KEY)
  stubFetch()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('assistant top bar', () => {
  it('sits in the shell with the ⌘K / Ctrl+K hint', async () => {
    renderShell()
    await expect.element(barInput()).toHaveAttribute('placeholder', 'Ask the company brain…')
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

  it('the one door: Jev routes first; a question goes on to the chat', async () => {
    renderShell()
    await barInput().fill('What is new?')
    await barInput().element().closest('form')!.requestSubmit()
    await expect.element(page.getByText('You said: What is new?')).toBeInTheDocument()
    const urls = calls.map((c) => c.url)
    expect(urls.indexOf('/api/assistant/route')).toBeLessThan(urls.indexOf('/api/chat'))
    expect(calls.find((c) => c.url === '/api/assistant/route')?.body).toEqual({ text: 'What is new?' })
  })

  it('the one door: a task is filed with no chat turn; the chip says so and change refiles it', async () => {
    routeReplies.push(
      () => Response.json({ outcome: 'filed', route: 'task', id: 't1', url: '/m/memory/tasks', decisionId: 'd1', confidence: 0.9, source: 'jev' }),
      () => Response.json({ outcome: 'filed', route: 'remember', id: 'th1', url: '/m/memory/capture?thought=th1', decisionId: 'd1', confidence: null, source: 'person' }),
    )
    renderShell()
    await barInput().fill('Send Acme the deck')
    await barInput().element().closest('form')!.requestSubmit()
    const chip = page.getByTestId('one-door-chip')
    await expect.element(chip).toHaveTextContent('Saved as task')
    await expect.element(panel()).not.toBeInTheDocument()
    expect(calls.some((c) => c.url === '/api/chat')).toBe(false)
    await page.getByTestId('one-door-change').click()
    await page.getByTestId('one-door-choice-remember').click()
    await expect.element(chip).toHaveTextContent('Saved as something to remember')
    expect(calls.filter((c) => c.url === '/api/assistant/route').at(-1)?.body).toEqual({
      text: 'Send Acme the deck',
      as: 'remember',
      decision_id: 'd1',
      replaces: { route: 'task', id: 't1' },
    })
  })

  it('the one door: unsure asks instead of guessing; a failure keeps the words and says why', async () => {
    routeReplies.push(
      () => Response.json({ outcome: 'unsure', decisionId: 'd2', choices: ['task', 'remember', 'question', 'document', 'reminder'] }),
      () => Response.json({ error: 'The brain could not take this in: jev down' }, { status: 502 }),
    )
    renderShell()
    await barInput().fill('Acme renewal')
    await barInput().element().closest('form')!.requestSubmit()
    await expect.element(page.getByTestId('one-door-chip')).toHaveTextContent('What is this?')
    await page.getByTestId('one-door-choice-task').click()
    await expect.element(page.getByTestId('one-door-error')).toHaveTextContent('Not saved: The brain could not take this in: jev down')
    expect(calls.some((c) => c.url === '/api/chat')).toBe(false)
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
    await expect.element(spotlight()).toHaveAccessibleName('Ask the company brain')
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

  it('disables transition while pointer resize drag is active and closes cleanly', async () => {
    await openPanel()
    const edge = page.getByTestId('assistant-resize')
    const el = edge.element()

    el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 1, button: 0, clientX: 800, bubbles: true }))
    await expect.element(panel()).toHaveAttribute('data-dragging', 'true')

    window.dispatchEvent(new PointerEvent('pointermove', { pointerId: 1, clientX: 760 }))
    await expect.element(edge).toHaveAttribute('aria-valuenow', String(PANEL_DEFAULT_WIDTH + 40))

    window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 1, clientX: 760 }))
    await expect.element(panel()).not.toHaveAttribute('data-dragging')

    el.dispatchEvent(new PointerEvent('pointerdown', { pointerId: 2, button: 0, clientX: 760, bubbles: true }))
    await expect.element(panel()).toHaveAttribute('data-dragging', 'true')
    await page.getByTestId('assistant-close').click()
    await expect.element(panel()).not.toBeInTheDocument()
  })

  it('opens and closes cleanly on mobile viewport', async () => {
    await page.viewport(414, 896)
    try {
      await openPanel()
      await expect.element(panel()).toBeInTheDocument()
      await page.getByTestId('assistant-close').click()
      await expect.element(panel()).not.toBeInTheDocument()
    } finally {
      await page.viewport(1400, 900)
    }
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

  it('shows each tool the assistant ran as a step, and what the reply cost under it', async () => {
    chatReplies = [
      () =>
        ndjson([
          { type: 'tool.preview', stepId: 'st-1', tool: 'memory.capture_thought', inputSummary: 'raw: Call Acme' },
          { type: 'tool.finished', stepId: 'st-1', tool: 'memory.capture_thought', failed: false, resultSummary: 'id: t-1' },
          { type: 'tool.preview', stepId: 'st-2', tool: 'email.send_mail', inputSummary: 'to: a@b.c' },
          { type: 'tool.finished', stepId: 'st-2', tool: 'email.send_mail', failed: true, resultSummary: 'subject is required' },
          {
            type: 'done',
            response: 'Saved it; the mail needs a subject.',
            sessionId: 's-1',
            messageId: 'm-2',
            usage: { costUsd: 0.0042, tokens: 1234, modelCalls: 3 },
          },
        ]),
    ]
    await openPanel()
    await page.getByTestId('assistant-composer-input').fill('note: call Acme, mail them')
    await page.getByTestId('assistant-send').click()
    await expect.element(page.getByText('Saved it; the mail needs a subject.')).toBeInTheDocument()
    const steps = page.getByTestId('tool-preview')
    await expect.element(steps.nth(0)).toHaveAttribute('data-status', 'done')
    await expect.element(steps.nth(0)).toHaveTextContent(/Capture thought/)
    await expect.element(steps.nth(1)).toHaveAttribute('data-status', 'failed')
    await expect.element(steps.nth(1)).toHaveTextContent(/subject is required/)
    await expect.element(page.getByTestId('assistant-reply-cost')).toHaveTextContent('$0.0042 · 1.2k tokens')
  })

  it('the header shows today’s AI use against the cap, red from 80 %, linking to the settings', async () => {
    usageToday = { ...usageToday, spentUsd: 0.42, remainingUsd: 0.08 }
    await openPanel()
    const meter = page.getByTestId('assistant-usage')
    await expect.element(meter).toBeVisible()
    await expect.element(meter).toHaveAttribute('data-zone', 'near')
    await expect.element(meter).toHaveTextContent(/\$0\.42 \/ \$0\.50/)
    await expect.element(page.getByTestId('assistant-usage-link')).toHaveAttribute('href', '/settings/llm')
    // After a reply the meter is read again (the reply may have cost something).
    const reads = () => calls.filter((c) => c.url === '/api/assistant/usage').length
    const before = reads()
    await page.getByTestId('assistant-composer-input').fill('hi')
    await page.getByTestId('assistant-send').click()
    await expect.element(page.getByText('You said: hi')).toBeInTheDocument()
    await expect.poll(reads).toBeGreaterThan(before)
  })

  it('owner and admins see their use with no cap; a failed read says so', async () => {
    usageToday = { ...usageToday, role: 'owner', capApplies: false, remainingUsd: null }
    await openPanel()
    await expect.element(page.getByTestId('assistant-usage')).toHaveAttribute('data-zone', 'exempt')
    await expect.element(page.getByTestId('assistant-usage')).toHaveTextContent(/\$0\.10 today/)
  })

  it('when the usage cannot be read, the chat says so instead of an amount', async () => {
    usageToday = null
    await openPanel()
    await expect.element(page.getByTestId('assistant-usage-failed')).toHaveTextContent('Your AI use today could not be read.')
    expect(document.querySelector('[data-testid="assistant-usage"]')).toBeNull()
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

  describe('editing the latest message (board a950ef11: edit after Stop, send it again)', () => {
    const composer = () => page.getByTestId('assistant-composer-input')
    const transcript = () => page.getByTestId('nucleus-transcript')
    const editButtons = () => page.getByRole('button', { name: 'Edit message' })

    /** A turn the server accepted (its message id first) whose reply never comes: the person stops it. */
    function hangingTurn(messageId: string) {
      return (signal: AbortSignal | null | undefined) =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                new TextEncoder().encode(
                  JSON.stringify({ type: 'turn.accepted', sessionId: 's-1', messageId }) + '\n',
                ),
              )
              signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')))
            },
          }),
          { status: 200, headers: { 'content-type': 'application/x-ndjson' } },
        )
    }

    function answeredTurn(messageId: string, response: string) {
      return () =>
        ndjson([
          { type: 'turn.accepted', sessionId: 's-1', messageId },
          { type: 'done', response, sessionId: 's-1', messageId: `${messageId}-reply` },
        ])
    }

    const chatBodies = () => calls.filter((c) => c.url === '/api/chat').map((c) => c.body)

    it('after Stop, Edit puts the words back; sending again replaces the stopped turn', async () => {
      chatReplies = [hangingTurn('m-1'), answeredTurn('m-2', 'The better answer.')]
      await openPanel()
      await composer().fill('Write the bakery homepag')
      await page.getByTestId('assistant-send').click()
      await expect.element(page.getByRole('button', { name: 'Stop' })).toBeInTheDocument()
      // While the reply runs there is nothing to edit yet.
      expect(editButtons().elements()).toHaveLength(0)
      await page.getByRole('button', { name: 'Stop' }).click()
      await expect.element(page.getByText('Stopped.')).toBeInTheDocument()

      await editButtons().click()
      await expect.element(composer()).toHaveValue('Write the bakery homepag')
      await expect.element(composer()).toHaveFocus()
      await expect.element(page.getByTestId('assistant-editing')).toHaveTextContent('Editing your message')

      await composer().fill('Write the bakery homepage')
      await page.getByTestId('assistant-send').click()

      await expect.element(page.getByText('The better answer.')).toBeInTheDocument()
      expect(chatBodies().at(-1)).toEqual({
        message: 'Write the bakery homepage',
        sessionId: 's-1',
        replacesMessageId: 'm-1',
      })
      // The stopped turn is gone from the conversation, as it is from the model's.
      await expect.element(page.getByText('Stopped.')).not.toBeInTheDocument()
      await expect.element(transcript()).not.toHaveTextContent('Write the bakery homepag ')
      await expect.element(page.getByText('Write the bakery homepage', { exact: true })).toBeInTheDocument()
      await expect.element(page.getByTestId('assistant-editing')).not.toBeInTheDocument()
    })

    it('also after a finished reply, only on the latest message; Cancel gives the composer back', async () => {
      conversation = {
        ...conversation,
        turns: [
          { role: 'user', content: 'Older question', messageId: 'm-0' },
          { role: 'assistant', content: 'Older answer' },
          { role: 'user', content: 'Latest question', messageId: 'm-1' },
          { role: 'assistant', content: 'Latest answer' },
        ],
      }
      await openPanel()
      await expect.element(page.getByText('Latest answer')).toBeInTheDocument()
      await expect.poll(() => editButtons().elements().length).toBe(1)

      await composer().fill('half a thought')
      await editButtons().click()
      await expect.element(composer()).toHaveValue('Latest question')
      await page.getByRole('button', { name: 'Cancel editing' }).click()
      await expect.element(composer()).toHaveValue('half a thought')
      await expect.element(page.getByTestId('assistant-editing')).not.toBeInTheDocument()
      // Nothing was sent; the conversation is as it was.
      expect(chatBodies()).toEqual([])
      await expect.element(page.getByText('Latest answer')).toBeInTheDocument()
    })

    it('no Edit once an approval card follows the message', async () => {
      conversation = {
        ...conversation,
        turns: [
          { role: 'user', content: 'Send the newsletter', messageId: 'm-1' },
          { role: 'approval', tool: 'email.send_mail', approvalId: 'ap-1', status: 'pending', action: 'send an email' },
        ],
      }
      await openPanel()
      await expect.element(page.getByText('Send the newsletter')).toBeInTheDocument()
      expect(editButtons().elements()).toHaveLength(0)
    })

    it('the files of a message come back with the edit and go with the resend', async () => {
      chatReplies = [answeredTurn('m-1', 'Summary one.'), answeredTurn('m-2', 'Summary two.')]
      await openPanel()
      const input = page.getByTestId('assistant-attach-input').element() as HTMLInputElement
      const transfer = new DataTransfer()
      transfer.items.add(new File(['Ship the bakery site.'], 'notes.md', { type: 'text/markdown' }))
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
      await expect.element(page.getByTestId('assistant-composer-attachment')).toHaveTextContent('notes.md')
      await composer().fill('Summarise this.')
      await page.getByTestId('assistant-send').click()
      await expect.element(page.getByText('Summary one.')).toBeInTheDocument()

      await editButtons().click()
      await expect.element(page.getByTestId('assistant-composer-attachment')).toHaveTextContent('notes.md')
      await composer().fill('Summarise this in one line.')
      await page.getByTestId('assistant-send').click()
      await expect.element(page.getByText('Summary two.')).toBeInTheDocument()
      expect(chatBodies().at(-1)).toEqual({
        message: 'Summarise this in one line.',
        attachments: [{ name: 'notes.md', kind: 'text', sizeBytes: 21, text: 'Ship the bakery site.' }],
        sessionId: 's-1',
        replacesMessageId: 'm-1',
      })
      await expect.element(page.getByText('Summary one.')).not.toBeInTheDocument()
    })

    it('a saved message whose files were not kept says so: the words come back, the files must be attached again', async () => {
      conversation = {
        ...conversation,
        turns: [
          {
            role: 'user',
            content: 'Summarise this.',
            messageId: 'm-1',
            attachments: [{ name: 'q3.pdf', kind: 'pdf', sizeBytes: 1_258_291 }],
          },
          { role: 'assistant', content: 'Done.' },
        ],
      }
      await openPanel()
      await editButtons().click()
      await expect.element(composer()).toHaveValue('Summarise this.')
      await expect
        .element(page.getByTestId('assistant-editing'))
        .toHaveTextContent('Attach q3.pdf again if the edited message still needs it.')
    })

    it('when the server refuses the edit, the conversation stays as it was and the words stay in the composer', async () => {
      conversation = {
        ...conversation,
        turns: [
          { role: 'user', content: 'Latest question', messageId: 'm-1' },
          { role: 'assistant', content: 'Latest answer' },
        ],
      }
      chatReplies = [
        () =>
          Response.json(
            { message: 'This message can no longer be edited. Send a new message instead.' },
            { status: 409 },
          ),
      ]
      await openPanel()
      await editButtons().click()
      await composer().fill('Latest question, edited')
      await page.getByTestId('assistant-send').click()
      await expect
        .element(page.getByText('This message can no longer be edited. Send a new message instead.'))
        .toBeInTheDocument()
      await expect.element(page.getByText('Latest answer')).toBeInTheDocument()
      await expect.element(page.getByText('Latest question', { exact: true })).toBeInTheDocument()
      await expect.element(composer()).toHaveValue('Latest question, edited')
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

describe('dictation in "Ask the company brain" (plan/shared-memory-voice-agent-tools.md §2)', () => {
  let doubles: ReturnType<typeof installVoiceDoubles>

  beforeEach(async () => {
    await page.viewport(1400, 900)
    doubles = installVoiceDoubles()
    voiceTranscript = 'what did we ship this week'
    appPage.data = { shell: { dictation: { ready: true } } }
  })
  afterEach(() => {
    doubles.restore()
    appPage.data = {}
  })

  async function dictate(testid: string): Promise<void> {
    await page.getByTestId(`${testid}-mic`).click()
    await expect.element(page.getByTestId(`${testid}-bar`)).toBeInTheDocument()
    FakeMediaRecorder.instances.at(-1)!.emitChunk([1, 2, 3])
    await page.getByTestId(`${testid}-send`).click()
    await expect.element(page.getByTestId(`${testid}-mic`)).toBeInTheDocument()
  }

  it('the top bar field has the mic; the words land in the field, focused, and nothing is asked yet', async () => {
    renderShell()
    await barInput().fill('Hey brain,')
    barInput().element().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    const mic = page.getByTestId('assistant-bar-voice-mic')
    expect(page.getByTestId('assistant-spotlight').element().contains(mic.element())).toBe(true)
    await dictate('assistant-bar-voice')
    await expect.element(barInput()).toHaveValue('Hey brain, what did we ship this week')
    await expect.element(barInput()).toHaveFocus()
    // the spotlight is open around the dictated question, Ask is ready, nothing went out
    await expect.element(page.getByTestId('assistant-spotlight')).toHaveAttribute('role', 'dialog')
    await expect.element(page.getByTestId('assistant-spotlight-submit')).toBeEnabled()
    expect(calls.some((c) => c.url === '/api/chat')).toBe(false)
    expect(calls.filter((c) => c.url === '/api/voice/transcribe')).toHaveLength(1)
  })

  it('while recording the voice bar takes the field’s row and Ask waits', async () => {
    renderShell()
    await page.getByTestId('assistant-bar-voice-mic').click()
    await expect.element(page.getByTestId('assistant-bar-voice-bar')).toBeInTheDocument()
    await expect.element(page.getByTestId('assistant-spotlight-submit')).not.toBeInTheDocument()
    await page.getByTestId('assistant-bar-voice-discard').click()
    await expect.element(barInput()).toHaveFocus()
    await expect.element(page.getByTestId('assistant-spotlight-submit')).toBeInTheDocument()
  })

  it('the panel composer: the mic left of Send works the same as Contribute', async () => {
    renderShell()
    await page.getByTestId('assistant-toggle').click()
    await expect.element(panel()).toBeInTheDocument()
    // The panel slides in (panelSlide); a person types once it has settled, and filling a
    // field mid-slide leaves Chromium's caret at 0.
    await Promise.all(panel().element().getAnimations().map((a) => a.finished))
    const composer = page.getByTestId('assistant-composer-input')
    await composer.fill('Summarise:')
    const wrapper = page.getByTestId('assistant-mic').element()
    expect(wrapper.querySelector('[data-testid="assistant-voice-mic"]')).not.toBeNull()
    await dictate('assistant-voice')
    await expect.element(composer).toHaveValue('Summarise: what did we ship this week')
    await expect.element(composer).toHaveFocus()
    await expect.element(page.getByTestId('assistant-send')).toBeEnabled()
    expect(calls.some((c) => c.url === '/api/chat')).toBe(false)
  })

  it('without speech-to-text the brain field’s mic says what is missing', async () => {
    appPage.data = { shell: { dictation: { ready: false, missing: 'platform_key' } } }
    renderShell()
    const mic = page.getByTestId('assistant-bar-voice-mic')
    await expect.element(mic).toHaveAttribute('aria-disabled', 'true')
    await mic.click({ force: true }) // aria-disabled: still tappable, it explains itself
    await expect
      .element(page.getByTestId('assistant-bar-voice-error'))
      .toHaveTextContent(DICTATION_MISSING_MESSAGE.platform_key)
    expect(doubles.getUserMedia).not.toHaveBeenCalled()
  })
})
