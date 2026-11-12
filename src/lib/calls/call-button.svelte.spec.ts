import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import { ActiveCall, activeCallContext } from './active-call.svelte'
import CallButton from './call-button.svelte'
import { CallRequestError, type CallDto } from './client'
import { FakeRoom, fakeCall, fakeEnv, fakeToken } from './fake-room'

/** The live call the nucleus layout provides (idle unless a spec joins one). */
function activeCall() {
  const room = new FakeRoom()
  return new ActiveCall({
    client: { accept: vi.fn(async () => fakeCall()), token: vi.fn(async () => fakeToken), hangup: vi.fn(async () => fakeCall()), get: vi.fn(async () => fakeCall()) },
    createRoom: async () => room,
    env: () => fakeEnv(),
  })
}
const mount = (props: Record<string, unknown>, active = activeCall()) =>
  render(CallButton, { props: props as never, context: activeCallContext(active) })

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
  it('Call starts a call with the conversation as its context, then opens it', async () => {
    const client = { start: vi.fn(async () => ({ ...live, id: 'call-new', contextKind: 'dm' as const, contextId: 'dm-1', state: 'ringing' as const })) }
    const onopen = vi.fn()
    mount({ kind: 'dm', contextId: 'dm-1', live: null, client, onopen })
    const button = page.getByTestId('messages-call')
    await expect.element(button).toHaveTextContent('Call')
    await expect.element(button).toHaveAttribute('data-live', 'false')
    await button.click()
    expect(client.start).toHaveBeenCalledExactlyOnceWith({ contextKind: 'dm', contextId: 'dm-1' })
    await vi.waitFor(() => expect(onopen).toHaveBeenCalledExactlyOnceWith('call-new'))
  })

  it('a live call in the conversation: the button says Join and opens that call', async () => {
    const client = { start: vi.fn() }
    const onopen = vi.fn()
    mount({ kind: 'channel', contextId: 'ch-1', live, client, onopen })
    const button = page.getByTestId('messages-call')
    await expect.element(button).toHaveTextContent('Join')
    await expect.element(button).toHaveAttribute('data-live', 'true')
    await button.click()
    expect(onopen).toHaveBeenCalledExactlyOnceWith('call-live')
    expect(client.start).not.toHaveBeenCalled()
  })

  it('a refused start says why (e.g. calls not set up)', async () => {
    const client = {
      start: vi.fn(async () => {
        throw new CallRequestError({ kind: 'not_configured', message: 'Calls are not set up on this server' })
      }),
    }
    const onopen = vi.fn()
    mount({ kind: 'dm', contextId: 'dm-1', live: null, client, onopen })
    await page.getByTestId('messages-call').click()
    await expect.element(page.getByTestId('messages-call-error')).toHaveTextContent('Calls are not set up on this server')
    expect(onopen).not.toHaveBeenCalled()
  })

  it('in another call already: says so and starts nothing (no one is rung)', async () => {
    const active = activeCall()
    active.open(fakeCall({ id: 'call-other', title: 'Standup' }), 'ann')
    await vi.waitFor(() => expect(active.state.phase).toBe('connected'))
    const client = { start: vi.fn() }
    const onopen = vi.fn()
    mount({ kind: 'dm', contextId: 'dm-1', live: null, client, onopen }, active)
    await page.getByTestId('messages-call').click()
    await expect.element(page.getByTestId('messages-call-error')).toHaveTextContent("You're already in a call (Standup). Hang up first to start this one.")
    expect(client.start).not.toHaveBeenCalled()
    expect(onopen).not.toHaveBeenCalled()
  })

  it('the live call here is the one I am in: Join opens it', async () => {
    const active = activeCall()
    active.open(fakeCall({ id: 'call-live' }), 'ann')
    await vi.waitFor(() => expect(active.state.phase).toBe('connected'))
    const onopen = vi.fn()
    mount({ kind: 'channel', contextId: 'ch-1', live, client: { start: vi.fn() }, onopen }, active)
    await page.getByTestId('messages-call').click()
    expect(onopen).toHaveBeenCalledExactlyOnceWith('call-live')
  })
})
