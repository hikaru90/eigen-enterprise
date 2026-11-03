import { describe, expect, it } from 'vitest'
import { createAutosave, LockLostError, type SaveStatus, type Timers } from './autosave'

/** Manual timers: tick() fires whatever is due. */
function fakeTimers() {
  let seq = 0
  const due = new Map<number, () => void>()
  const timers: Timers = {
    set(fn) {
      due.set(++seq, fn)
      return seq
    },
    clear(h) {
      due.delete(h as number)
    },
  }
  return {
    timers,
    pending: () => due.size,
    tick() {
      const fns = [...due.values()]
      due.clear()
      for (const fn of fns) fn()
    },
  }
}

function deferred() {
  let resolve!: () => void
  let reject!: (e: unknown) => void
  const promise = new Promise<void>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const settle = () => new Promise((r) => setTimeout(r, 0))

function setup(save: (c: string) => Promise<void>) {
  const t = fakeTimers()
  const seen: SaveStatus[] = []
  const lost: LockLostError[] = []
  const a = createAutosave({ save, delayMs: 1000, timers: t.timers, onState: (s) => seen.push(s.status), onLost: (e) => lost.push(e) })
  return { a, t, seen, lost }
}

describe('autosave', () => {
  it('debounces: many changes, one save of the newest content', async () => {
    const saves: string[] = []
    const { a, t } = setup(async (c) => void saves.push(c))
    a.change('a')
    a.change('ab')
    a.change('abc')
    expect(a.state().status).toBe('dirty')
    expect(t.pending()).toBe(1)
    t.tick()
    await settle()
    expect(saves).toEqual(['abc'])
    expect(a.state().status).toBe('saved')
    expect(a.state().savedAt).toBeInstanceOf(Date)
    expect(a.unsaved()).toBeNull()
  })

  it('shows saving while the request runs', async () => {
    const d = deferred()
    const { a, t } = setup(() => d.promise)
    a.change('x')
    t.tick()
    expect(a.state().status).toBe('saving')
    d.resolve()
    await settle()
    expect(a.state().status).toBe('saved')
  })

  it('an edit during a save is saved right after (never lost)', async () => {
    const saves: string[] = []
    const gates = [deferred(), deferred()]
    const { a, t } = setup((c) => {
      saves.push(c)
      return gates[saves.length - 1]!.promise
    })
    a.change('one')
    t.tick()
    a.change('two')
    expect(a.unsaved()).toBe('two')
    gates[0]!.resolve()
    await settle()
    expect(a.state().status).toBe('dirty')
    t.tick()
    gates[1]!.resolve()
    await settle()
    expect(saves).toEqual(['one', 'two'])
    expect(a.state().status).toBe('saved')
  })

  it('a failed save is an error with the reason; edits are kept and retry saves them', async () => {
    let fail = true
    const saves: string[] = []
    const { a, t } = setup(async (c) => {
      if (fail) throw new Error('Network down')
      saves.push(c)
    })
    a.change('draft')
    t.tick()
    await settle()
    expect(a.state()).toMatchObject({ status: 'error', error: 'Network down' })
    expect(a.unsaved()).toBe('draft')
    fail = false
    await a.retry()
    expect(saves).toEqual(['draft'])
    expect(a.state().status).toBe('saved')
  })

  it('flush saves immediately (no waiting for the debounce)', async () => {
    const saves: string[] = []
    const { a, t } = setup(async (c) => void saves.push(c))
    a.change('now')
    await a.flush()
    expect(saves).toEqual(['now'])
    expect(t.pending()).toBe(0)
  })

  it('changing back to the saved content is clean again', async () => {
    const { a, t } = setup(async () => {})
    a.change('v1')
    t.tick()
    await settle()
    a.change('v2')
    a.change('v1')
    expect(a.state().status).toBe('saved')
    expect(t.pending()).toBe(0)
  })

  it('losing the lock stops saving and keeps the draft', async () => {
    const saves: string[] = []
    const { a, t, lost } = setup(async (c) => {
      saves.push(c)
      throw new LockLostError('Ben took over editing.', 'ben')
    })
    a.change('mine')
    t.tick()
    await settle()
    expect(a.state()).toMatchObject({ status: 'lost', error: 'Ben took over editing.' })
    expect(lost[0]?.holderId).toBe('ben')
    a.change('more of mine')
    expect(t.pending()).toBe(0)
    await a.flush()
    expect(saves).toEqual(['mine'])
    expect(a.unsaved()).toBe('more of mine')
  })

  it('stop() is terminal; reset() marks reloaded content as saved', async () => {
    const { a } = setup(async () => {})
    a.change('x')
    a.reset('server text')
    expect(a.state().status).toBe('saved')
    expect(a.unsaved()).toBeNull()
    a.stop()
    expect(a.state().status).toBe('lost')
  })
})
