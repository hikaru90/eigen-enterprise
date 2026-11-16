import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { CALL_TAB_BLOCKED, type CallTabWindow, type OpenWindow } from './call-tab'
import { CallRequestError, type CallDto } from './client'
import IncomingCallToast from './incoming-call-toast.svelte'
import { LiveCalls } from './live-calls.svelte'

const ringing = (over: Partial<CallDto> = {}): CallDto => ({
  id: 'call-1',
  contextKind: 'dm',
  contextId: 'dm-1',
  title: 'Ann Example, Ben Example',
  startedBy: 'ben',
  startedByName: 'Ben Example',
  state: 'ringing',
  startedAt: new Date().toISOString(),
  answeredAt: null,
  endedAt: null,
  ringUntil: new Date(Date.now() + 45_000).toISOString(),
  participants: [],
  ...over,
})

/** A blank tab as window.open hands it back (null: the browser blocked it). */
function fakeTab() {
  const t = {
    name: '',
    hrefs: [] as string[],
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
    close: vi.fn(),
  }
  return t
}

function setup(inCall: string | null = null, tab: ReturnType<typeof fakeTab> | null = fakeTab()) {
  const live = new LiveCalls()
  const client = { decline: vi.fn(async (id: string) => ringing({ id, state: 'declined' })) }
  const open = vi.fn<OpenWindow>(() => tab as CallTabWindow | null)
  const ringer = { start: vi.fn(), stop: vi.fn() }
  render(IncomingCallToast, { live, client, open, ringer, inCall })
  return { live, client, open, tab, ringer }
}

describe('incoming-call-toast.svelte', () => {
  it('nothing rings: no toast, no ringtone', async () => {
    const { ringer } = setup()
    expect(page.getByTestId('incoming-call').elements()).toHaveLength(0)
    expect(ringer.start).not.toHaveBeenCalled()
    expect(ringer.stop).toHaveBeenCalled()
  })

  it('a ringing call shows who calls and rings; Accept opens the call in its own tab (which answers it) and the ring stops', async () => {
    const { live, client, open, tab, ringer } = setup()
    live.apply('call.ringing', ringing())
    const toast = page.getByTestId('incoming-call')
    await expect.element(toast.getByTestId('incoming-call-caller')).toHaveTextContent('Ben Example')
    await expect.element(toast.getByTestId('incoming-call-where')).toHaveTextContent('Video call')
    expect(ringer.start).toHaveBeenCalled()
    await page.getByTestId('incoming-call-accept').click()
    expect(open).toHaveBeenCalledExactlyOnceWith('', 'ee-call-call-1')
    expect(tab!.hrefs).toEqual(['/calls/call-1'])
    expect(client.decline).not.toHaveBeenCalled()
    await expect.element(toast).not.toBeInTheDocument()
    expect(ringer.stop).toHaveBeenCalled()
  })

  it('Decline declines and hides the toast; it never opens the call', async () => {
    const { live, client, open } = setup()
    live.apply('call.ringing', ringing({ contextKind: 'channel', contextId: 'ch-1', title: '#general' }))
    await expect.element(page.getByTestId('incoming-call-where')).toHaveTextContent('Call in #general')
    await page.getByTestId('incoming-call-decline').click()
    expect(client.decline).toHaveBeenCalledExactlyOnceWith('call-1')
    await expect.element(page.getByTestId('incoming-call')).not.toBeInTheDocument()
    expect(open).not.toHaveBeenCalled()
  })

  it('the toast goes away when the call stops ringing for me (state frame), and the ringtone stops', async () => {
    const { live, ringer } = setup()
    live.apply('call.ringing', ringing())
    await expect.element(page.getByTestId('incoming-call')).toBeInTheDocument()
    ringer.stop.mockClear()
    live.apply('call.state', ringing({ state: 'missed', endedAt: new Date().toISOString() }))
    await expect.element(page.getByTestId('incoming-call')).not.toBeInTheDocument()
    expect(ringer.stop).toHaveBeenCalled()
  })

  it('the browser blocked the call tab: says so, and the call keeps ringing so Accept can be tried again', async () => {
    const { live } = setup(null, null)
    live.apply('call.ringing', ringing())
    await page.getByTestId('incoming-call-accept').click()
    await expect.element(page.getByTestId('incoming-call-error')).toHaveTextContent(CALL_TAB_BLOCKED)
    await expect.element(page.getByTestId('incoming-call')).toBeInTheDocument()
    await expect.element(page.getByTestId('incoming-call-accept')).toBeEnabled()
  })

  it('a refused decline says why', async () => {
    const { live, client } = setup()
    client.decline.mockRejectedValueOnce(new CallRequestError({ kind: 'over', message: 'this call is over' }))
    live.apply('call.ringing', ringing())
    await page.getByTestId('incoming-call-decline').click()
    await expect.element(page.getByTestId('incoming-call-error')).toHaveTextContent('this call is over')
  })

  it('already in another call (in any tab): says so plainly, Accept is off, Decline still works', async () => {
    const { live, client, open } = setup('call-current')
    live.apply('call.ringing', ringing({ id: 'call-2' }))
    const toast = page.getByTestId('incoming-call')
    await expect.element(toast.getByTestId('incoming-call-busy')).toHaveTextContent("You're already in a call. Hang up to answer this one.")
    await expect.element(toast.getByTestId('incoming-call-accept')).toBeDisabled()
    await toast.getByTestId('incoming-call-decline').click()
    expect(client.decline).toHaveBeenCalledExactlyOnceWith('call-2')
    expect(open).not.toHaveBeenCalled()
  })
})
