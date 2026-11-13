import { describe, expect, it, vi } from 'vitest'
import { createEditPhaseTimer, logEditComplete, logEditFailure } from './edit-phase-timing'

describe('edit-phase-timing', () => {
  it('never logs the edit request or the edit summary — Memory text stays out of the logs', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const timer = createEditPhaseTimer({ userId: 'u1', thoughtId: 't1' })
    const secret = 'say I am afraid of losing my job'

    logEditComplete({
      logCtx: { userId: 'u1', thoughtId: 't1' },
      path: 'full_reenrich',
      textChanged: true,
      nextStatus: 'open',
      editSummary: `Rewrote it to: ${secret}`,
      timing: timer.finish(),
    })
    logEditFailure({
      logCtx: { userId: 'u1', thoughtId: 't1' },
      err: new Error('persist failed'),
      timing: timer.finish(),
      editRequestChars: secret.length,
    })

    const logged = JSON.stringify([...infoSpy.mock.calls, ...errorSpy.mock.calls])
    expect(logged).not.toContain(secret)
    expect(errorSpy).toHaveBeenCalledWith(
      '[capture.edit] failed',
      expect.objectContaining({ editRequestChars: secret.length }),
    )
    errorSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('createEditPhaseTimer logs phase failure and rethrows', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})
    const timer = createEditPhaseTimer({ userId: 'u1', thoughtId: 't1' })

    await expect(
      timer.time('load_existing', async () => {
        throw new Error('db timeout')
      }),
    ).rejects.toThrow('db timeout')

    expect(infoSpy).toHaveBeenCalledWith('[capture.edit] phase start', {
      userId: 'u1',
      thoughtId: 't1',
      phase: 'load_existing',
    })
    expect(errorSpy).toHaveBeenCalledWith(
      '[capture.edit] phase failed',
      expect.objectContaining({
        userId: 'u1',
        thoughtId: 't1',
        phase: 'load_existing',
        message: 'db timeout',
      }),
    )

    errorSpy.mockRestore()
    infoSpy.mockRestore()
  })

  it('logEditFailure includes err message', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const timer = createEditPhaseTimer({ userId: 'u1', thoughtId: 't1' })

    logEditFailure({
      logCtx: { userId: 'u1', thoughtId: 't1' },
      err: new Error('persist failed'),
      timing: timer.finish(),
      editRequestChars: 9,
    })

    expect(errorSpy).toHaveBeenCalledWith(
      '[capture.edit] failed',
      expect.objectContaining({
        message: 'persist failed',
        editRequestChars: 9,
      }),
    )

    errorSpy.mockRestore()
  })
})
