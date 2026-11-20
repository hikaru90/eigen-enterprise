import { describe, expect, it, vi } from 'vitest'
import { createDriveBlobsTick, DRIVE_BLOB_SWEEP_EVERY_MS } from './drive-blobs-tick'

describe('drive blob sweep on the job-queue tick', () => {
  it('sweeps on the first tick, then at most once per interval', async () => {
    const sweep = vi.fn(async () => ({ removed: 0 }))
    let now = new Date('2026-11-20T12:00:00Z')
    const tick = createDriveBlobsTick({ sweep, now: () => now, log: () => {} })

    await tick()
    expect(sweep).toHaveBeenCalledTimes(1)

    now = new Date(now.getTime() + DRIVE_BLOB_SWEEP_EVERY_MS - 1)
    await tick()
    expect(sweep).toHaveBeenCalledTimes(1)

    now = new Date(now.getTime() + 1)
    await tick()
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('logs a failure loudly, never throws into the tick, and retries on the next interval', async () => {
    const sweep = vi.fn(async () => {
      throw new Error('disk gone')
    })
    const log = vi.fn()
    let now = new Date('2026-11-20T12:00:00Z')
    const tick = createDriveBlobsTick({ sweep, now: () => now, log })

    await expect(tick()).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('[drive] blob sweep failed', { message: 'disk gone' })

    now = new Date(now.getTime() + DRIVE_BLOB_SWEEP_EVERY_MS)
    await tick()
    expect(sweep).toHaveBeenCalledTimes(2)
  })

  it('reports how many unreferenced blobs it removed', async () => {
    const log = vi.fn()
    const tick = createDriveBlobsTick({ sweep: async () => ({ removed: 3 }), now: () => new Date(), log })
    await tick()
    expect(log).toHaveBeenCalledWith('[drive] blob sweep removed unreferenced blobs', { removed: 3 })
  })
})
