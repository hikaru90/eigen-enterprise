import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTelegramLoop, startTelegramLoop, type TelegramGatewayLike } from './loop'

function makeGateway(script: Array<(offset: number) => Promise<number>>): {
  gateway: TelegramGatewayLike
  calls: Array<{ offset: number; timeoutSec: number }>
} {
  const calls: Array<{ offset: number; timeoutSec: number }> = []
  const gateway: TelegramGatewayLike = {
    async runCycle(offset: number, timeoutSec: number): Promise<number> {
      calls.push({ offset, timeoutSec })
      const next = script.shift()
      if (!next) return offset
      return next(offset)
    },
  }
  return { gateway, calls }
}

const GAP = 50

describe('startTelegramLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('runs cycles sequentially, feeding each returned offset into the next cycle', async () => {
    const { gateway, calls } = makeGateway([
      async (offset) => offset + 5,
      async (offset) => offset + 7,
    ])

    const loop = startTelegramLoop({
      gateway,
      pollTimeoutSec: 25,
      errorBackoffMs: 10,
      idleGapMs: GAP,
    })

    // First cycle starts immediately; each idle gap gates the next one.
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toEqual([{ offset: 0, timeoutSec: 25 }])

    await vi.advanceTimersByTimeAsync(GAP)
    expect(calls).toEqual([
      { offset: 0, timeoutSec: 25 },
      { offset: 5, timeoutSec: 25 },
    ])

    await vi.advanceTimersByTimeAsync(GAP)
    expect(calls).toEqual([
      { offset: 0, timeoutSec: 25 },
      { offset: 5, timeoutSec: 25 },
      { offset: 12, timeoutSec: 25 },
    ])

    await loop.stop()
    expect(loop.running).toBe(false)
  })

  it('backs off with exponential delay after a failed cycle and continues', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let failing = true
    const { gateway, calls } = makeGateway([
      async () => {
        if (failing) throw new Error('telegram getUpdates failed (500): boom')
        return 1
      },
      async () => {
        if (failing) throw new Error('telegram getUpdates failed (500): boom')
        return 2
      },
    ])

    const loop = startTelegramLoop({
      gateway,
      pollTimeoutSec: 10,
      errorBackoffMs: 100,
      idleGapMs: GAP,
    })
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)
    expect(warn).toHaveBeenCalledWith(
      '[orchestrator.loop] telegram cycle failed; retrying',
      expect.objectContaining({ backoffMs: 100 }),
    )
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret-message-content')

    // Still inside the first backoff window (0-100ms): no new cycle yet.
    await vi.advanceTimersByTimeAsync(60)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    // Once the backoff elapses the cycle retries (still failing -> doubled backoff).
    await vi.advanceTimersByTimeAsync(60)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(2)
    expect(warn).toHaveBeenCalledWith(
      '[orchestrator.loop] telegram cycle failed; retrying',
      expect.objectContaining({ backoffMs: 200 }),
    )

    // Recovery: next successful cycle advances the offset again.
    failing = false
    await vi.advanceTimersByTimeAsync(400)
    await vi.advanceTimersByTimeAsync(0)
    const last = calls.at(-1)
    expect(last?.offset).toBe(0)
    expect(loop.running).toBe(true)

    await loop.stop()
  })

  it('resets the backoff after a successful cycle', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let fail = true
    const { gateway } = makeGateway([
      async () => {
        if (fail) throw new Error('flaky')
        return 9
      },
      async () => {
        fail = true
        throw new Error('flaky again')
      },
      async () => {
        throw new Error('flaky once more')
      },
    ])

    const loop = startTelegramLoop({
      gateway,
      pollTimeoutSec: 1,
      errorBackoffMs: 40,
      idleGapMs: 10,
    })
    await vi.advanceTimersByTimeAsync(0) // cycle 1 fails -> backoff 40
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(40) // cycle 2 succeeds
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(10) // cycle 3 fails -> backoff reset to 40 (not 80)
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(40) // cycle 4 runs -> proves the reset
    await vi.advanceTimersByTimeAsync(0)
    expect(warn).toHaveBeenCalledTimes(2)

    await loop.stop()
  })

  it('stop() terminates: no further cycles after the in-flight one finishes', async () => {
    const { gateway, calls } = makeGateway([async (offset) => offset + 1])

    const loop = startTelegramLoop({
      gateway,
      pollTimeoutSec: 5,
      errorBackoffMs: 10,
      idleGapMs: GAP,
    })
    await vi.advanceTimersByTimeAsync(0)

    await loop.stop()
    const callsAtStop = calls.length
    await vi.advanceTimersByTimeAsync(60_000)

    expect(calls.length).toBe(callsAtStop)
    expect(loop.running).toBe(false)
  })

  it('stop() interrupts an in-progress backoff sleep immediately', async () => {
    const { gateway } = makeGateway([
      async () => {
        throw new Error('down')
      },
    ])

    const loop = startTelegramLoop({
      gateway,
      pollTimeoutSec: 1,
      errorBackoffMs: 60_000,
      idleGapMs: 10,
    })
    await vi.advanceTimersByTimeAsync(0)

    const start = Date.now()
    await loop.stop()
    expect(Date.now() - start).toBeLessThan(60_000)
    expect(loop.running).toBe(false)
  })
})

describe('createTelegramLoop', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('creates a loop without starting it', async () => {
    const { gateway, calls } = makeGateway([])
    const loop = createTelegramLoop({ gateway, pollTimeoutSec: 1, errorBackoffMs: 5, idleGapMs: 10 })

    expect(loop.running).toBe(false)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(0)

    loop.start()
    expect(loop.running).toBe(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(calls).toHaveLength(1)

    await loop.stop()
  })

  it('does not restart an already running loop and tolerates double stop', async () => {
    const { gateway, calls } = makeGateway([])
    const loop = createTelegramLoop({ gateway, pollTimeoutSec: 1, errorBackoffMs: 5, idleGapMs: 10 })

    loop.start()
    loop.start()
    await vi.advanceTimersByTimeAsync(0)
    const callsAfterStart = calls.length
    expect(callsAfterStart).toBe(1)
    await vi.advanceTimersByTimeAsync(10)
    expect(calls.length).toBe(2)

    await loop.stop()
    await loop.stop()
    expect(loop.running).toBe(false)
  })
})
