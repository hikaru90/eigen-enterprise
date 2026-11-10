import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createIngestPhaseTimer } from './phase-timing'

// Fake timers (they fake Date too): real setTimeout runs on a monotonic clock while Date.now()
// truncates to whole ms, so a real 5 ms + 3 ms sleep can measure 7 ms on a busy runner (CI
// flake). With a controlled clock the durations are exact.
beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}

describe('capture phase-timing', () => {
  it('records per-phase durations and wall clock', async () => {
    const timer = createIngestPhaseTimer()
    const normalize = timer.time('normalize', () => sleep(5))
    await vi.advanceTimersByTimeAsync(5)
    await normalize
    const embedding = timer.time('embedding', () => sleep(3))
    await vi.advanceTimersByTimeAsync(3)
    await embedding
    const report = timer.finish()
    expect(report.phases).toEqual([
      { phase: 'normalize', ms: 5 },
      { phase: 'embedding', ms: 3 },
    ])
    expect(report.wallMs).toBe(8)
  })
})
