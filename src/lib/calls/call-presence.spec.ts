import { describe, expect, it, vi } from 'vitest'
import { ActiveCall } from './active-call.svelte'
import { CallPresence, type PresenceChannel, type PresenceMessage, type TrackedCall } from './call-presence.svelte'
import { FakeRoom, fakeCall, fakeEnv, fakeToken } from './fake-room'

/** A BroadcastChannel stand-in: a message reaches every other tab's channel, never the sender's. */
function bus() {
  const members = new Set<{ deliver: (m: PresenceMessage) => void }>()
  const sent: PresenceMessage[] = []
  const open = (): PresenceChannel => {
    const fns: Array<(e: MessageEvent<PresenceMessage>) => void> = []
    const me = { deliver: (m: PresenceMessage) => fns.forEach((fn) => fn({ data: m } as MessageEvent<PresenceMessage>)) }
    members.add(me)
    return {
      postMessage(m) {
        sent.push(m)
        for (const other of members) if (other !== me) other.deliver(structuredClone(m))
      },
      addEventListener: (_type, fn) => fns.push(fn),
      close: () => members.delete(me),
    }
  }
  return { open, sent }
}

/** A live call whose state the spec moves by hand. */
function fakeActive(call = { id: 'call-1', title: 'Standup' }) {
  const fns = new Set<() => void>()
  const a = {
    inCall: false,
    call: null as { id: string; title: string } | null,
    subscribe: (fn: () => void) => {
      fns.add(fn)
      return () => fns.delete(fn)
    },
    join() {
      a.inCall = true
      a.call = call
      fns.forEach((fn) => fn())
    },
    end() {
      a.inCall = false
      fns.forEach((fn) => fn())
    },
    listeners: () => fns.size,
  }
  return a
}
const tracked = (a: ReturnType<typeof fakeActive>) => a as unknown as TrackedCall

describe('CallPresence: which call this browser is in, across tabs', () => {
  it('the main tab sees the call tab join and leave', () => {
    const b = bus()
    const main = new CallPresence()
    main.connect(b.open)
    const callTab = new CallPresence()
    callTab.connect(b.open)
    const active = fakeActive()
    callTab.track(tracked(active))
    expect(main.current).toBeNull()

    active.join()
    expect(main.current).toEqual({ id: 'call-1', title: 'Standup' })
    expect(callTab.current).toEqual({ id: 'call-1', title: 'Standup' })

    active.end()
    expect(main.current).toBeNull()
    expect(callTab.current).toBeNull()
  })

  it('a tab opened during the call asks, and the call tab answers', () => {
    const b = bus()
    const callTab = new CallPresence()
    callTab.connect(b.open)
    const active = fakeActive()
    active.join()
    callTab.track(tracked(active))

    const late = new CallPresence()
    late.connect(b.open)
    expect(late.current).toEqual({ id: 'call-1', title: 'Standup' })
  })

  it('tracking before the channel is open (the page mounts before the layout): announced on connect', () => {
    const b = bus()
    const main = new CallPresence()
    main.connect(b.open)
    const callTab = new CallPresence()
    const active = fakeActive()
    active.join()
    callTab.track(tracked(active))
    expect(main.current).toBeNull()
    callTab.connect(b.open)
    expect(main.current).toEqual({ id: 'call-1', title: 'Standup' })
  })

  it('the call page going away (stop tracking) says the call is gone and stops listening', () => {
    const b = bus()
    const main = new CallPresence()
    main.connect(b.open)
    const callTab = new CallPresence()
    callTab.connect(b.open)
    const active = fakeActive()
    const stop = callTab.track(tracked(active))
    active.join()
    stop()
    expect(main.current).toBeNull()
    expect(active.listeners()).toBe(0)
  })

  it('closing the call tab layout says so too; a gone call that was never here changes nothing', () => {
    const b = bus()
    const main = new CallPresence()
    main.connect(b.open)
    const callTab = new CallPresence()
    callTab.connect(b.open)
    const active = fakeActive()
    callTab.track(tracked(active))
    active.join()
    callTab.close()
    expect(main.current).toBeNull()
    expect(b.sent.at(-1)).toEqual({ type: 'gone', id: 'call-1' })
  })

  it('tracks a real ActiveCall: here while joining and connected, gone after hanging up', async () => {
    const b = bus()
    const main = new CallPresence()
    main.connect(b.open)
    const callTab = new CallPresence()
    callTab.connect(b.open)
    const room = new FakeRoom()
    const active = new ActiveCall({
      client: { accept: vi.fn(async () => fakeCall()), token: vi.fn(async () => fakeToken), hangup: vi.fn(async () => fakeCall()), get: vi.fn(async () => fakeCall()) },
      createRoom: async () => room,
      env: () => fakeEnv(),
    })
    callTab.track(active)
    active.open(fakeCall({ title: 'Design review' }), 'ann')
    expect(main.current).toEqual({ id: 'call-1', title: 'Design review' })
    await vi.waitFor(() => expect(active.state.phase).toBe('connected'))
    expect(main.current?.id).toBe('call-1')
    await active.hangUp()
    expect(main.current).toBeNull()
  })
})
