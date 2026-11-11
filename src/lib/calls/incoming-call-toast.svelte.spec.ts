import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
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

function setup() {
  const live = new LiveCalls()
  const client = { accept: vi.fn(async (id: string) => ringing({ id, state: 'active' })), decline: vi.fn(async (id: string) => ringing({ id, state: 'declined' })) }
  const onjoin = vi.fn()
  const ringer = { start: vi.fn(), stop: vi.fn() }
  render(IncomingCallToast, { live, client, onjoin, ringer })
  return { live, client, onjoin, ringer }
}

describe('incoming-call-toast.svelte', () => {
  it('nothing rings: no toast, no ringtone', async () => {
    const { ringer } = setup()
    expect(page.getByTestId('incoming-call').elements()).toHaveLength(0)
    expect(ringer.start).not.toHaveBeenCalled()
    expect(ringer.stop).toHaveBeenCalled()
  })

  it('a ringing call shows who calls and rings; Accept answers it, then goes to the call', async () => {
    const { live, client, onjoin, ringer } = setup()
    live.apply('call.ringing', ringing())
    const toast = page.getByTestId('incoming-call')
    await expect.element(toast.getByTestId('incoming-call-caller')).toHaveTextContent('Ben Example')
    await expect.element(toast.getByTestId('incoming-call-where')).toHaveTextContent('Video call')
    expect(ringer.start).toHaveBeenCalled()
    await page.getByTestId('incoming-call-accept').click()
    expect(client.accept).toHaveBeenCalledExactlyOnceWith('call-1')
    expect(client.decline).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(onjoin).toHaveBeenCalledExactlyOnceWith('call-1'))
    await expect.element(toast).not.toBeInTheDocument()
    expect(ringer.stop).toHaveBeenCalled()
  })

  it('Decline declines and hides the toast; it never opens the call', async () => {
    const { live, client, onjoin } = setup()
    live.apply('call.ringing', ringing({ contextKind: 'channel', contextId: 'ch-1', title: '#general' }))
    await expect.element(page.getByTestId('incoming-call-where')).toHaveTextContent('Call in #general')
    await page.getByTestId('incoming-call-decline').click()
    expect(client.decline).toHaveBeenCalledExactlyOnceWith('call-1')
    await expect.element(page.getByTestId('incoming-call')).not.toBeInTheDocument()
    expect(onjoin).not.toHaveBeenCalled()
    expect(client.accept).not.toHaveBeenCalled()
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

  it('a refused accept says why', async () => {
    const { live, client, onjoin } = setup()
    client.accept.mockRejectedValueOnce(new CallRequestError({ kind: 'over', message: 'this call is over' }))
    live.apply('call.ringing', ringing())
    await page.getByTestId('incoming-call-accept').click()
    await expect.element(page.getByTestId('incoming-call-error')).toHaveTextContent('this call is over')
    expect(onjoin).not.toHaveBeenCalled()
  })
})
