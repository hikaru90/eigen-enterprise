import { describe, expect, it, vi } from 'vitest'
import { CallPresence, type PresenceChannel, type TrackedCall } from './call-presence.svelte'

/** In a real browser: the real BroadcastChannel (structured clone, async delivery), reactive state as the app runs it. */
describe('CallPresence over a real BroadcastChannel', () => {
  it('the main tab sees the call tab join and leave', async () => {
    const name = `ee-calls-presence-spec-${crypto.randomUUID()}`
    const open = () => new BroadcastChannel(name) as PresenceChannel
    const main = new CallPresence()
    main.connect(open)
    const callTab = new CallPresence()
    callTab.connect(open)

    const fns = new Set<() => void>()
    const active = {
      inCall: false,
      call: null as { id: string; title: string } | null,
      subscribe: (fn: () => void) => (fns.add(fn), () => fns.delete(fn)),
    }
    callTab.track(active as unknown as TrackedCall)
    active.inCall = true
    active.call = { id: 'call-1', title: 'Standup' }
    fns.forEach((fn) => fn())
    await vi.waitFor(() => expect(main.current).toEqual({ id: 'call-1', title: 'Standup' }))

    // A tab opened later asks and gets the answer.
    const late = new CallPresence()
    late.connect(open)
    await vi.waitFor(() => expect(late.current).toEqual({ id: 'call-1', title: 'Standup' }))

    active.inCall = false
    fns.forEach((fn) => fn())
    await vi.waitFor(() => expect(main.current).toBeNull())
    await vi.waitFor(() => expect(late.current).toBeNull())
    for (const p of [main, callTab, late]) p.close()
  })
})
