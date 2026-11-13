import { afterEach, describe, expect, it, vi } from 'vitest'
import { startPresence } from './start'

/**
 * Heartbeats must never wait for the "in a call" watcher to follow every
 * member: each heartbeat holds a request-reserved DB connection while it
 * waits, and following ~1 000 members needs the same pool — ten waiting
 * heartbeats exhausted the pool and the whole server hung (found by the
 * phone-home e2e journey, 2026-11-13).
 */
describe('startPresence', () => {
  afterEach(() => vi.useRealTimers())

  it('answers with a working tracker before following members has finished', async () => {
    let finish!: () => void
    const follow = vi.fn(() => new Promise<void>((r) => (finish = r)))
    const tracker = await startPresence({
      now: () => new Date('2026-11-13T12:00:00Z'),
      watcher: () => ({ follow, reconcile: async () => {} }),
      memberIds: async () => ['u1', 'u2'],
      onError: () => {},
    })
    tracker.heartbeat('u1', 'client-0001', 'active')
    expect(tracker.get('u1').status).toBe('online')
    await vi.waitFor(() => expect(follow).toHaveBeenCalledWith(['u1', 'u2']))
    finish()
  })

  it('a failed follow is reported (never silent) and tried again on the next refresh', async () => {
    vi.useFakeTimers()
    const errors: unknown[] = []
    let calls = 0
    const follow = vi.fn(async () => {
      if (++calls === 1) throw new Error('db down')
    })
    await startPresence({
      now: () => new Date(),
      watcher: () => ({ follow, reconcile: async () => {} }),
      memberIds: async () => ['u1'],
      onError: (e) => errors.push(e),
      refreshMs: 1000,
      sweepMs: 1000,
    })
    await vi.waitFor(() => expect(errors).toHaveLength(1))
    expect(String(errors[0])).toContain('db down')
    await vi.advanceTimersByTimeAsync(1000)
    expect(follow).toHaveBeenCalledTimes(2)
    expect(errors).toHaveLength(1)
  })
})
