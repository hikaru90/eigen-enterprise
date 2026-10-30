import { vi } from 'vitest'
import type { AgentEventStream, SnapshotEvent } from '$lib/server/agent/pi-durable'

/**
 * A fake pi-durable AgentEventStream (the seam `DurableHarnessBox.events`
 * returns): the test drives commits with `emit` and observes `stop`.
 */
export function fakeEventStream(snapshot?: Partial<SnapshotEvent>) {
  let listener: ((events: readonly unknown[], context: unknown) => Promise<void>) | undefined
  let resolveClosed!: (end: unknown) => void
  const closed = new Promise((resolve) => (resolveClosed = resolve))
  const stop = vi.fn(async () => {
    resolveClosed({ type: 'stopped' })
    return { type: 'stopped' }
  })
  const stream = {
    snapshot: {
      type: 'snapshot',
      entries: [],
      tools: [],
      nestedTools: [],
      compactions: [],
      inbox: [],
      agent: {},
      usage: {},
      ...snapshot,
    },
    start: (l: typeof listener) => {
      listener = l
    },
    stop,
    closed,
  } as unknown as AgentEventStream
  return {
    stream,
    stop,
    emit: async (events: unknown[]) => {
      if (!listener) throw new Error('fake event stream emitted before start()')
      await listener(events, undefined)
    },
    close: () => resolveClosed({ type: 'closed' }),
  }
}
