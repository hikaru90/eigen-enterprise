import { beforeEach, describe, expect, it, vi } from 'vitest'

const { recoverMock, ensureMock, drainMock, snapshotMock, emailTickMock, pluginOnMock } = vi.hoisted(() => ({
  recoverMock: vi.fn(),
  ensureMock: vi.fn(),
  drainMock: vi.fn(),
  snapshotMock: vi.fn(),
  emailTickMock: vi.fn(),
  pluginOnMock: vi.fn(),
}))

vi.mock('./ensure-overnight', () => ({
  ensureOvernightJobsEnqueued: ensureMock,
}))
vi.mock('./drain', () => ({
  drainUserJobQueue: drainMock,
}))
vi.mock('./snapshot', () => ({
  loadJobQueueSnapshot: snapshotMock,
}))
vi.mock('./email-tick', () => ({
  tickEmailPlatform: emailTickMock,
}))
vi.mock('$lib/server/plugins/background', () => ({
  pluginOn: pluginOnMock,
}))
vi.mock('./recover-stale-running', () => ({
  recoverStaleRunningJobs: recoverMock,
}))

describe('tickGlobalJobQueue', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    recoverMock.mockResolvedValue(0)
    ensureMock.mockResolvedValue(0)
    emailTickMock.mockResolvedValue(undefined)
    pluginOnMock.mockResolvedValue(true)
    drainMock.mockResolvedValue({ claimed: 0, completed: 0, failed: 0 })
    snapshotMock.mockResolvedValue({
      pendingDue: 0,
      pendingFuture: 0,
      running: 0,
      failed: 0,
      oldestDuePendingAgeSec: null,
    })
  })

  it('clears ticking after a tick timeout so the next interval can run', async () => {
    let hangDrain = true
    drainMock.mockImplementation(() => {
      if (hangDrain) {
        return new Promise(() => {
          /* never resolves */
        })
      }
      return Promise.resolve({ claimed: 0, completed: 0, failed: 0 })
    })
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { tickGlobalJobQueue } = await import('./tick')

    await expect(tickGlobalJobQueue(50)).rejects.toThrow(/job-queue tick timeout/)
    hangDrain = false
    await expect(tickGlobalJobQueue(50)).resolves.toEqual({
      enqueued: 0,
      drain: { claimed: 0, completed: 0, failed: 0 },
    })

    expect(warnSpy).not.toHaveBeenCalledWith(
      '[job-queue] tick skipped — previous tick still running',
    )
    warnSpy.mockRestore()
  })

  // Owner, 2026-11-12: a switched-off plugin's background work skips.
  it('skips the overnight consolidation (Memory) and the email work (Email) while switched off; the drain still runs', async () => {
    pluginOnMock.mockImplementation(async (plugin: string) => plugin !== 'memory' && plugin !== 'email')
    const { tickGlobalJobQueue } = await import('./tick')
    await expect(tickGlobalJobQueue()).resolves.toEqual({ enqueued: 0, drain: { claimed: 0, completed: 0, failed: 0 } })
    expect(ensureMock).not.toHaveBeenCalled()
    expect(emailTickMock).not.toHaveBeenCalled()
    expect(drainMock).toHaveBeenCalledOnce()
    expect(pluginOnMock).toHaveBeenCalledWith('memory', 'overnight consolidation')
    expect(pluginOnMock).toHaveBeenCalledWith('email', 'email background work (DNS checks, scheduled sends, flows)')
  })

  it('runs both while the plugins are on', async () => {
    const { tickGlobalJobQueue } = await import('./tick')
    await tickGlobalJobQueue()
    expect(ensureMock).toHaveBeenCalledOnce()
    expect(emailTickMock).toHaveBeenCalledOnce()
  })
})
