import type { CallChatMessageDto, CallChatPage, CallDto, ChatClient } from './client'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page, userEvent } from 'vitest/browser'
import { ActiveCall } from './active-call.svelte'
import { CallBrain } from './call-brain.svelte'
import { CallChat } from './call-chat.svelte'
import { CallTranscription } from './call-transcription.svelte'
import CallView from './call-view.svelte'
import { CallRequestError } from './client'
import { FakeRoom, fakeCall, fakeEnv, fakeToken } from './fake-room'

/**
 * The chat in the call view (proposal bb05b451): the toggle in the controls
 * with an unread badge while the panel is closed, the panel beside the stage
 * (over it on a phone), Enter sends, guests marked, a refusal shown.
 */

const line = (
  seq: number,
  authorId: string,
  body: string,
  kind: 'member' | 'guest' = 'member',
): CallChatMessageDto => ({
  seq,
  authorId,
  authorKind: kind,
  authorName:
    kind === 'guest' ? 'Kim Kunde' : `${authorId[0]!.toUpperCase()}${authorId.slice(1)} Example`,
  body,
  image: null,
  createdAt: new Date(Date.UTC(2026, 10, 23, 10, 0, seq)).toISOString(),
})

function fakeChatServer(initial: CallChatMessageDto[] = []) {
  const lines = [...initial]
  const client: ChatClient = {
    readChat: vi.fn(async (_id: string, since: number): Promise<CallChatPage> => ({
      messages: lines.filter((m) => m.seq > since),
      hasMore: false,
    })),
    postChat: vi.fn(async (_id: string, body: string) => {
      const m = line((lines.at(-1)?.seq ?? 0) + 1, 'ann', body)
      lines.push(m)
      return m
    }),
    postChatImage: vi.fn(async (_id: string, file: File) => {
      const m: CallChatMessageDto = {
        ...line((lines.at(-1)?.seq ?? 0) + 1, 'ann', ''),
        image: { id: 'img-1', name: file.name, mime: file.type, size: file.size },
      }
      lines.push(m)
      return m
    }),
    imageUrl: (_id: string, imageId: string) => `data:image/png;base64,iVBORw0KGgo=#${imageId}`,
  }
  return { lines, client }
}

/** The call view with the chat; `member: true` adds everything a member's controls carry (transcript switch, Brain). */
function mount(opts: { chat?: ChatClient; member?: boolean; canShareScreen?: boolean } = {}) {
  const room = new FakeRoom()
  const call: CallDto = fakeCall()
  const client = {
    accept: vi.fn(async () => call),
    token: vi.fn(async () => fakeToken),
    hangup: vi.fn(async () => fakeCall({ state: 'ended' })),
    get: vi.fn(async () => call),
    transcribe: vi.fn(async () => null),
    setTranscription: vi.fn(async () => call),
  }
  const env = fakeEnv(
    opts.canShareScreen === undefined ? {} : { canShareScreen: opts.canShareScreen },
  )
  const active = new ActiveCall({ client, createRoom: async () => room, env: () => env })
  const server = fakeChatServer()
  const chat = new CallChat({ callId: 'call-1', me: 'ann', client: opts.chat ?? server.client })
  const transcription = opts.member
    ? new CallTranscription({
        active,
        me: 'ann',
        client,
        record: () => ({ stop: async () => new Blob(['x'], { type: 'audio/webm' }) }),
        hasSpeech: async () => true,
        chunkMs: 30_000,
        now: () => Date.now(),
        setTimer: (fn, ms) => setTimeout(fn, ms),
        clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
      })
    : null
  transcription?.connect()
  const brain = opts.member
    ? new CallBrain({
        active,
        me: 'ann',
        client: {
          setBrain: vi.fn(async () => call),
          askBrain: vi.fn(),
          myBrainAnswers: vi.fn(async () => []),
          shareBrainAnswer: vi.fn(async () => call),
          brainRecap: vi.fn(async () => ''),
        },
      })
    : null
  render(CallView, {
    active,
    call,
    me: 'ann',
    leaveLabel: 'Close',
    onleave: () => {},
    onhungup: () => {},
    onopen: () => {},
    chat,
    chatDictation: false,
    transcription,
    brain,
  })
  return { chat, server, active }
}

const connected = () =>
  expect.element(page.getByTestId('call-view')).toHaveAttribute('data-phase', 'connected')

describe('the chat in a call', () => {
  it('lines from others while closed show as a badge on the toggle; opening the panel shows them and clears it', async () => {
    const { chat } = mount()
    await connected()
    const toggle = page.getByTestId('call-chat-button')
    await expect.element(toggle).toHaveAccessibleName('Chat')
    expect(page.getByTestId('call-chat-unread').elements()).toHaveLength(0)
    chat.receive('call-1', line(1, 'ben', 'Hallo Ann'))
    chat.receive('call-1', line(2, 'guest:k', 'Guten Tag', 'guest'))
    await expect.element(page.getByTestId('call-chat-unread')).toHaveTextContent('2')
    await expect.element(toggle).toHaveAccessibleName('Chat, 2 unread')
    await toggle.click()
    const panel = page.getByTestId('call-chat-panel')
    await expect.element(panel).toBeVisible()
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true')
    expect(page.getByTestId('call-chat-unread').elements()).toHaveLength(0)
    await expect.element(page.getByTestId('call-chat-body').nth(0)).toHaveTextContent('Hallo Ann')
    await expect.element(page.getByTestId('call-chat-author').nth(1)).toHaveTextContent('Kim Kunde')
    await expect.element(page.getByTestId('call-chat-guest')).toHaveTextContent('Guest')
    // Closed again: a new line counts once more.
    await page.getByRole('button', { name: 'Close the chat' }).click()
    chat.receive('call-1', line(3, 'ben', 'Noch da?'))
    await expect.element(page.getByTestId('call-chat-unread')).toHaveTextContent('1')
  })

  it('Enter sends (Shift+Enter is a new line); my line shows as mine; the field empties', async () => {
    const { server } = mount()
    await connected()
    await page.getByTestId('call-chat-button').click()
    await expect.element(page.getByTestId('call-chat-empty')).toBeVisible()
    const draft = page.getByTestId('call-chat-draft')
    await draft.click()
    await userEvent.keyboard('Zeile eins{Shift>}{Enter}{/Shift}Zeile zwei{Enter}')
    await expect.element(page.getByTestId('call-chat-message')).toHaveAttribute('data-mine', 'true')
    expect(server.client.postChat).toHaveBeenCalledWith('call-1', 'Zeile eins\nZeile zwei')
    await expect.element(page.getByTestId('call-chat-author')).toHaveTextContent('You')
    await expect.element(draft).toHaveValue('')
    await expect.element(page.getByTestId('call-chat-send')).toBeDisabled()
  })

  it('a pasted image is sent as a line of its own and shown inline (wish 4fbf9991)', async () => {
    const { server } = mount()
    await connected()
    await page.getByTestId('call-chat-button').click()
    const draft = page.getByTestId('call-chat-draft')
    const file = new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    draft
      .element()
      .dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }),
      )
    await expect.element(page.getByTestId('call-chat-image')).toBeInTheDocument()
    expect(server.client.postChatImage).toHaveBeenCalledWith('call-1', file)
    await expect.element(page.getByTestId('call-chat-image')).toHaveAttribute('alt', 'shot.png')
  })

  it('the message field takes the dark stage tokens, never the page text colour (wish 4fbf9991: black on black)', async () => {
    // Component specs run without Tailwind (vitest.browser.config.ts): this guards the structure that
    // decides the colour — the panel re-scopes the tokens dark (.ink-scope, held to AA by
    // layout.contrast.spec.ts) and the field sets its own light text over the page's text-foreground.
    mount()
    await connected()
    await page.getByTestId('call-chat-button').click()
    const el = page.getByTestId('call-chat-draft').element()
    expect(el.closest('.ink-scope')).toBe(page.getByTestId('call-chat-panel').element())
    expect(el.classList).toContain('text-neutral-50')
  })

  it('a refused line keeps the text and says why', async () => {
    const refusing: ChatClient = {
      readChat: async () => ({ messages: [], hasMore: false }),
      postChat: async () => {
        throw new CallRequestError({ kind: 'failed', message: 'this call is over', agent: null })
      },
      postChatImage: async () => {
        throw new CallRequestError({ kind: 'failed', message: 'this call is over', agent: null })
      },
      imageUrl: () => '',
    }
    mount({ chat: refusing })
    await connected()
    await page.getByTestId('call-chat-button').click()
    await page.getByTestId('call-chat-draft').fill('Tschüss')
    await page.getByTestId('call-chat-send').click()
    await expect
      .element(page.getByTestId('call-chat-problem'))
      .toHaveTextContent('Not sent: this call is over')
    await expect.element(page.getByTestId('call-chat-draft')).toHaveValue('Tschüss')
  })

  it('the Brain panel and the chat take turns as the one side panel', async () => {
    mount({ member: true })
    await connected()
    await page.getByTestId('call-chat-button').click()
    await expect.element(page.getByTestId('call-chat-panel')).toBeVisible()
    await page.getByTestId('call-brain-button').click()
    await expect.element(page.getByTestId('call-brain-panel')).toBeVisible()
    expect(page.getByTestId('call-chat-panel').elements()).toHaveLength(0)
    await page.getByTestId('call-chat-button').click()
    await expect.element(page.getByTestId('call-chat-panel')).toBeVisible()
    expect(page.getByTestId('call-brain-panel').elements()).toHaveLength(0)
  })

  it('on a phone a member’s controls (chat included) fit one row; the panel covers the stage; no sideways scroll', async () => {
    await page.viewport(375, 740)
    mount({ member: true, canShareScreen: false })
    await connected()
    await expect.element(page.getByTestId('call-transcribe')).toBeVisible()
    const controls = page.getByTestId('call-controls').element() as HTMLElement
    const tops = new Set(
      [...controls.querySelectorAll('button')].map((b) =>
        Math.round(b.getBoundingClientRect().top),
      ),
    )
    expect(tops.size).toBe(1)
    expect(controls.scrollWidth).toBeLessThanOrEqual(controls.clientWidth)
    await page.getByTestId('call-chat-button').click()
    const panel = page.getByTestId('call-chat-panel').element().parentElement as HTMLElement
    const stage = page.getByTestId('call-stage').element() as HTMLElement
    const p = panel.getBoundingClientRect()
    const st = stage.getBoundingClientRect()
    expect(p.width).toBeGreaterThanOrEqual(st.width)
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(375)
  })
})
