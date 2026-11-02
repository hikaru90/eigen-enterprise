import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPromptShutdown } from './shutdown'

function fakeProcess() {
  const emitter = new EventEmitter()
  const exit = vi.fn()
  return { proc: Object.assign(emitter, { exit }), exit }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('prompt shutdown (D3: recovery-on-reopen, never wait out SIGKILL)', () => {
  it('SIGTERM with a never-ending request (streaming turn / SSE): exits after the grace, lock released first', () => {
    const { proc, exit } = fakeProcess()
    const order: string[] = []
    exit.mockImplementation(() => order.push('exit'))
    installPromptShutdown({ process: proc as never, graceMs: 2000, beforeExit: () => order.push('release lock'), log: () => {} })
    proc.emit('SIGTERM')
    vi.advanceTimersByTime(1999)
    expect(exit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(exit).toHaveBeenCalledWith(0)
    expect(order).toEqual(['release lock', 'exit'])
  })

  it('exits as soon as every request closed, and only once', () => {
    const { proc, exit } = fakeProcess()
    installPromptShutdown({ process: proc as never, graceMs: 2000, log: () => {} })
    proc.emit('SIGTERM')
    proc.emit('sveltekit:shutdown')
    vi.advanceTimersByTime(5000)
    expect(exit).toHaveBeenCalledTimes(1)
  })
})
