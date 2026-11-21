import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import CallButton from './call-button.svelte'
import {
  CallPresence,
  callPresenceContext,
  type PresenceChannel,
  type PresenceMessage,
} from './call-presence.svelte'
import { CALL_TAB_BLOCKED, type CallTabWindow, type OpenWindow } from './call-tab'
import { CallRequestError, type CallDto } from './client'

/** A tab as window.open hands it back: records where it was sent, and whether it was closed. */
function fakeTab() {
  const t = {
    name: '',
    hrefs: [] as string[],
    closed: false,
    location: {
      pathname: 'blank',
      get href() {
        return t.location.pathname
      },
      set href(v: string) {
        t.hrefs.push(v)
        t.location.pathname = v
      },
    },
    focus: vi.fn(),
    close: vi.fn(() => {
      t.closed = true
    }),
  }
  return t
}

/** The presence the nucleus layout provides; `elsewhere` = another tab of this browser is in that call. */
function presence(elsewhere: { id: string; title: string } | null = null) {
  const p = new CallPresence()
  const fns: Array<(e: MessageEvent<PresenceMessage>) => void> = []
  const channel: PresenceChannel = {
    postMessage: () => {},
    addEventListener: (_t, fn) => fns.push(fn),
    close: () => {},
  }
  p.connect(() => channel)
  if (elsewhere)
    for (const fn of fns)
      fn({ data: { type: 'here', call: elsewhere } } as MessageEvent<PresenceMessage>)
  return p
}

function mount(
  props: Record<string, unknown>,
  opts: { elsewhere?: { id: string; title: string }; tab?: ReturnType<typeof fakeTab> | null } = {},
) {
  const tab = opts.tab === undefined ? fakeTab() : opts.tab
  const open = vi.fn<OpenWindow>(() => tab as CallTabWindow | null)
  render(CallButton, {
    props: { ...props, open } as never,
    context: callPresenceContext(presence(opts.elsewhere ?? null)),
  })
  return { tab, open }
}

const live: CallDto = {
  id: 'call-live',
  contextKind: 'channel',
  contextId: 'ch-1',
  title: '#general',
  startedBy: 'ben',
  startedByName: 'Ben Example',
  state: 'active',
  startedAt: '2026-11-11T09:00:00.000Z',
  answeredAt: '2026-11-11T09:00:05.000Z',
  endedAt: null,
  ringUntil: '2026-11-11T09:00:45.000Z',
  participants: [],
}

describe('call-button.svelte', () => {
  it('Call reserves the call tab in the click, starts a call for the conversation, then shows it in that tab', async () => {
    let started = (_: CallDto) => {}
    const client = { start: vi.fn(() => new Promise<CallDto>((r) => (started = r))) }
    const { tab, open } = mount({ kind: 'dm', contextId: 'dm-1', live: null, client })
    const button = page.getByTestId('messages-call')
    await expect.element(button).toHaveTextContent('Call')
    await expect.element(button).toHaveAttribute('data-live', 'false')
    await button.click()
    // The tab is there before the server answered (popup blockers allow only that).
    expect(open).toHaveBeenCalledOnce()
    expect(open.mock.calls[0][1]).toMatch(/^ee-call-starting-/)
    expect(client.start).toHaveBeenCalledExactlyOnceWith({ contextKind: 'dm', contextId: 'dm-1' })
    expect(tab!.hrefs).toEqual([])
    started({ ...live, id: 'call-new', contextKind: 'dm', contextId: 'dm-1', state: 'ringing' })
    await vi.waitFor(() => expect(tab!.hrefs).toEqual(['/calls/call-new']))
    expect(tab!.name).toBe('ee-call-call-new')
    expect(tab!.closed).toBe(false)
  })

  it('a live call in the conversation: the button says Join and opens that call in its tab', async () => {
    const client = { start: vi.fn() }
    const { tab, open } = mount({ kind: 'channel', contextId: 'ch-1', live, client })
    const button = page.getByTestId('messages-call')
    await expect.element(button).toHaveTextContent('Join')
    await expect.element(button).toHaveAttribute('data-live', 'true')
    await button.click()
    expect(open).toHaveBeenCalledExactlyOnceWith('', 'ee-call-call-live')
    expect(tab!.hrefs).toEqual(['/calls/call-live'])
    expect(client.start).not.toHaveBeenCalled()
  })

  it('a refused start says why (e.g. calls not set up) and closes the reserved tab', async () => {
    const client = {
      start: vi.fn(async () => {
        throw new CallRequestError({
          kind: 'not_configured',
          message: 'Calls are not set up on this server',
          agent: null,
        })
      }),
    }
    const { tab } = mount({ kind: 'dm', contextId: 'dm-1', live: null, client })
    await page.getByTestId('messages-call').click()
    await expect
      .element(page.getByTestId('messages-call-error'))
      .toHaveTextContent('Calls are not set up on this server')
    await expect
      .element(
        page
          .getByTestId('messages-call-error')
          .getByRole('button', { name: 'Copy agent instructions' }),
      )
      .toBeInTheDocument()
    expect(tab!.closed).toBe(true)
    expect(tab!.hrefs).toEqual([])
  })

  it('the browser blocked the call tab: says so and starts nothing (no one is rung)', async () => {
    const client = { start: vi.fn() }
    mount({ kind: 'dm', contextId: 'dm-1', live: null, client }, { tab: null })
    await page.getByTestId('messages-call').click()
    await expect
      .element(page.getByTestId('messages-call-error'))
      .toHaveTextContent(CALL_TAB_BLOCKED)
    expect(client.start).not.toHaveBeenCalled()
  })

  it('the browser blocked the tab for Join: says so', async () => {
    mount({ kind: 'channel', contextId: 'ch-1', live, client: { start: vi.fn() } }, { tab: null })
    await page.getByTestId('messages-call').click()
    await expect
      .element(page.getByTestId('messages-call-error'))
      .toHaveTextContent(CALL_TAB_BLOCKED)
  })

  it('in another call already (in another tab): says so, opens no tab and starts nothing', async () => {
    const client = { start: vi.fn() }
    const { open } = mount(
      { kind: 'dm', contextId: 'dm-1', live: null, client },
      { elsewhere: { id: 'call-other', title: 'Standup' } },
    )
    await page.getByTestId('messages-call').click()
    await expect
      .element(page.getByTestId('messages-call-error'))
      .toHaveTextContent("You're already in a call (Standup). Hang up first to start this one.")
    expect(client.start).not.toHaveBeenCalled()
    expect(open).not.toHaveBeenCalled()
  })

  it('the live call here is the one I am in (in its tab): Join brings that tab to the front', async () => {
    const tab = fakeTab()
    tab.location.pathname = '/calls/call-live'
    const { open } = mount(
      { kind: 'channel', contextId: 'ch-1', live, client: { start: vi.fn() } },
      { elsewhere: { id: 'call-live', title: '#general' }, tab },
    )
    await page.getByTestId('messages-call').click()
    expect(open).toHaveBeenCalledExactlyOnceWith('', 'ee-call-call-live')
    expect(tab.hrefs).toEqual([])
    expect(tab.focus).toHaveBeenCalledOnce()
  })
})
