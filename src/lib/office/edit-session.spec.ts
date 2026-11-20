import { describe, expect, it, vi } from 'vitest'
import { DriveApiError, type DriveItem, type LockHolder, type LockView } from '$lib/drive/api'
import { LockLostError } from '$lib/drive/autosave'
import { createOfficeEditSession, type EditSessionApi } from './edit-session'

const holder: LockHolder = { userId: 'bob', sessionId: 'tab-bob-1', since: '2026-11-20T10:00:00Z', name: 'Bob' }
const file = { id: 'f1', type: 'file', name: 'plan.pdf' } as DriveItem

function fakes(lock: LockView = { state: 'held', since: '2026-11-20T10:00:00Z' }) {
  let tick: (() => void) | null = null
  const api = {
    acquireLock: vi.fn<EditSessionApi['acquireLock']>(async () => lock),
    heartbeatLock: vi.fn<EditSessionApi['heartbeatLock']>(async () => ({ state: 'held', since: '2026-11-20T10:00:00Z' })),
    releaseLock: vi.fn<EditSessionApi['releaseLock']>(async () => undefined),
    writeBytes: vi.fn<EditSessionApi['writeBytes']>(async () => ({ file })),
  }
  const timers = {
    every: vi.fn((fn: () => void) => {
      tick = fn
      return 1
    }),
    clear: vi.fn(() => {
      tick = null
    }),
  }
  return { api, timers, beat: () => tick?.() }
}

describe('office edit session (one editor per file, W-6)', () => {
  it('takes the lock, heartbeats it, saves under it and lets it go', async () => {
    const { api, timers, beat } = fakes()
    const s = createOfficeEditSession({ fileId: 'f1', heartbeatMs: 15_000, api, timers, sessionId: 'tab-ada-1' })
    expect(await s.start()).toMatchObject({ state: 'held' })
    expect(api.acquireLock).toHaveBeenCalledWith('f1', 'tab-ada-1', false)
    expect(timers.every).toHaveBeenCalledWith(expect.any(Function), 15_000)
    beat()
    expect(api.heartbeatLock).toHaveBeenCalledWith('f1', 'tab-ada-1')
    const bytes = new Uint8Array([1, 2])
    expect(await s.save(bytes)).toBe(file)
    expect(api.writeBytes).toHaveBeenCalledWith('f1', bytes, 'tab-ada-1')
    await s.stop()
    expect(timers.clear).toHaveBeenCalled()
    expect(api.releaseLock).toHaveBeenCalledWith('f1', 'tab-ada-1')
    expect(s.held()).toBe(false)
  })

  it('someone else editing: not held, no heartbeat; takeover asks for it', async () => {
    const { api, timers } = fakes({ state: 'locked', holder })
    const s = createOfficeEditSession({ fileId: 'f1', heartbeatMs: 15_000, api, timers, sessionId: 'tab-ada-1' })
    expect(await s.start()).toEqual({ state: 'locked', holder })
    expect(s.held()).toBe(false)
    expect(timers.every).not.toHaveBeenCalled()
    await expect(s.save(new Uint8Array([1]))).rejects.toBeInstanceOf(LockLostError)
    api.acquireLock.mockResolvedValue({ state: 'held', since: '2026-11-20T10:01:00Z' })
    await s.start({ takeover: true })
    expect(api.acquireLock).toHaveBeenLastCalledWith('f1', 'tab-ada-1', true)
    expect(s.held()).toBe(true)
  })

  it('a heartbeat that finds a take-over ends the session and says who', async () => {
    const { api, timers, beat } = fakes()
    const onLost = vi.fn()
    const s = createOfficeEditSession({ fileId: 'f1', heartbeatMs: 15_000, api, timers, sessionId: 'tab-ada-1', onLost })
    await s.start()
    api.heartbeatLock.mockResolvedValue({ state: 'locked', holder })
    beat()
    await vi.waitFor(() => expect(onLost).toHaveBeenCalledWith(holder))
    expect(s.held()).toBe(false)
    expect(timers.clear).toHaveBeenCalled()
  })

  it('a save refused because someone took over ends the session with LockLostError', async () => {
    const { api, timers } = fakes()
    const onLost = vi.fn()
    const s = createOfficeEditSession({ fileId: 'f1', heartbeatMs: 15_000, api, timers, sessionId: 'tab-ada-1', onLost })
    await s.start()
    api.writeBytes.mockRejectedValue(new DriveApiError('Bob took over editing; your changes were not saved.', 409, 'locked', holder))
    await expect(s.save(new Uint8Array([1]))).rejects.toBeInstanceOf(LockLostError)
    expect(onLost).toHaveBeenCalledWith(holder)
    expect(s.held()).toBe(false)
  })

  it('other save failures surface as they are; the session stays', async () => {
    const { api, timers } = fakes()
    const s = createOfficeEditSession({ fileId: 'f1', heartbeatMs: 15_000, api, timers, sessionId: 'tab-ada-1' })
    await s.start()
    const err = new DriveApiError('That content is not a PDF', 400, 'invalid', null)
    api.writeBytes.mockRejectedValue(err)
    await expect(s.save(new Uint8Array([1]))).rejects.toBe(err)
    expect(s.held()).toBe(true)
  })
})
