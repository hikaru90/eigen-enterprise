import type { RecapRunResult, RecapSchedulerDeps } from './schedule'
import { describe, expect, it } from 'vitest'
import { createRecapScheduler, recapDayKey } from './schedule'

function runResult(dayIso: string): RecapRunResult {
  return {
    deliveredChats: ['200'],
    chunkCount: 1,
    eventCount: 0,
    window: { start: new Date(dayIso), end: new Date(dayIso) },
    pendingApprovals: 0,
  }
}

function fakeDeps(runs: Date[], active = true): RecapSchedulerDeps & { runs: Date[] } {
  const state = { runs: [] as Date[] }
  return {
    runs: state.runs,
    isActive: async () => active,
    runOnce: async (now: Date) => {
      state.runs.push(now)
      runs.push(now)
      return runResult(now.toISOString())
    },
  }
}

describe('createRecapScheduler', () => {
  const morning = new Date('2026-09-09T05:00:00.000Z')
  const evening = new Date('2026-09-09T21:00:00.000Z')
  const nextDay = new Date('2026-09-10T05:00:00.000Z')

  it('runs once per day even if ticked repeatedly', async () => {
    const deps = fakeDeps([])
    const scheduler = createRecapScheduler(deps)

    await expect(scheduler.maybeRun(morning)).resolves.toBe(true)
    await expect(scheduler.maybeRun(evening)).resolves.toBe(false)
    await expect(scheduler.maybeRun(morning)).resolves.toBe(false)
    await expect(scheduler.maybeRun(nextDay)).resolves.toBe(true)

    expect(deps.runs).toHaveLength(2)
    expect(scheduler.lastRunDay()).toBe('2026-09-10')
  })

  it('does not run while the module is inactive (fail closed), and the guard stays unset', async () => {
    const deps = fakeDeps([], false)
    const scheduler = createRecapScheduler(deps)

    await expect(scheduler.maybeRun(morning)).resolves.toBe(false)
    expect(deps.runs).toHaveLength(0)
    expect(scheduler.lastRunDay()).toBeNull()
  })

  it('keeps the day guard open when a run fails, so the next tick retries the same day', async () => {
    let fail = true
    const scheduler = createRecapScheduler({
      isActive: async () => true,
      runOnce: async () => {
        if (fail) throw new Error('telegram sendMessage failed (502)')
        return runResult(morning.toISOString())
      },
    })

    await expect(scheduler.maybeRun(morning)).rejects.toThrow(/telegram/)
    await expect(scheduler.maybeRun(evening)).rejects.toThrow(/telegram/)

    fail = false
    await expect(scheduler.maybeRun(evening)).resolves.toBe(true)
    expect(scheduler.lastRunDay()).toBe('2026-09-09')
    await expect(scheduler.maybeRun(evening)).resolves.toBe(false)
  })
})

describe('recapDayKey', () => {
  it('keys on the UTC calendar day', () => {
    expect(recapDayKey(new Date('2026-09-09T23:59:59.999Z'))).toBe('2026-09-09')
    expect(recapDayKey(new Date('2026-09-10T00:00:00.000Z'))).toBe('2026-09-10')
  })
})
