/**
 * Debounced autosave for the Drive editors (D2). Pure state machine — the
 * timer and the save call are injected, so it is unit-tested without a
 * browser:
 *
 *   saved ──change──▶ dirty ──(delay)──▶ saving ──ok──▶ saved
 *                       ▲                  │  └─fail──▶ error ──retry/change──▶ saving/dirty
 *                       └──change while saving (saved again right after)
 *   any ──save throws LockLostError / stop()──▶ lost (terminal; the draft is kept)
 *
 * Edits are never dropped: the newest content is held until a save of
 * exactly that content succeeds (`unsaved()` returns it otherwise).
 */

export type SaveStatus = 'saved' | 'dirty' | 'saving' | 'error' | 'lost'

export type AutosaveState = { status: SaveStatus; error: string | null; savedAt: Date | null }

/** Thrown by the save function when this editor no longer holds the edit lock. */
export class LockLostError extends Error {
  constructor(
    message: string,
    readonly holderId: string | null = null,
  ) {
    super(message)
  }
}

export type Timers = { set(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export type Autosave = {
  state(): AutosaveState
  change(content: string): void
  /** Saves now when there is anything unsaved; resolves when that save ends (never throws). */
  flush(): Promise<void>
  retry(): Promise<void>
  /** Stops saving for good (the lock went to someone else); the unsaved draft stays readable. */
  stop(): void
  /** The content not yet saved, or null when everything is saved. */
  unsaved(): string | null
  /** Treats `content` as saved (after a reload/restore replaced the document). */
  reset(content: string): void
}

export function createAutosave(opts: {
  save: (content: string) => Promise<void>
  delayMs: number
  onState?: (s: AutosaveState) => void
  onLost?: (err: LockLostError) => void
  timers?: Timers
  now?: () => Date
}): Autosave {
  const timers: Timers = opts.timers ?? { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }
  const now = opts.now ?? (() => new Date())
  let state: AutosaveState = { status: 'saved', error: null, savedAt: null }
  let latest: string | null = null
  let saved: string | null = null
  let timer: unknown = null
  let inflight: Promise<void> | null = null

  const set = (patch: Partial<AutosaveState>) => {
    state = { ...state, ...patch }
    opts.onState?.(state)
  }
  const clearTimer = () => {
    if (timer !== null) timers.clear(timer)
    timer = null
  }
  const pending = () => latest !== null && latest !== saved
  /** A function, not a property read: the status changes across awaits (TS narrowing can't see that). */
  const isLost = () => state.status === 'lost'

  async function run(): Promise<void> {
    clearTimer()
    if (isLost()) return
    if (inflight) {
      await inflight
      return pending() && !isLost() ? run() : undefined
    }
    if (!pending()) return
    const content = latest!
    set({ status: 'saving', error: null })
    inflight = (async () => {
      try {
        await opts.save(content)
        saved = content
        if (isLost()) return
        set({ status: pending() ? 'dirty' : 'saved', savedAt: now(), error: null })
      } catch (err) {
        if (err instanceof LockLostError) {
          set({ status: 'lost', error: err.message })
          opts.onLost?.(err)
        } else set({ status: 'error', error: err instanceof Error ? err.message : String(err) })
      }
    })()
    try {
      await inflight
    } finally {
      inflight = null
    }
    if (state.status === 'dirty' && pending()) schedule()
  }

  function schedule() {
    clearTimer()
    timer = timers.set(() => {
      timer = null
      void run()
    }, opts.delayMs)
  }

  return {
    state: () => state,
    change(content) {
      if (state.status === 'lost') {
        latest = content
        return
      }
      latest = content
      if (!pending()) {
        clearTimer()
        if (state.status === 'dirty' || state.status === 'error') set({ status: 'saved', error: null })
        return
      }
      if (state.status !== 'saving') set({ status: 'dirty', error: null })
      schedule()
    },
    flush: run,
    retry: run,
    stop() {
      clearTimer()
      set({ status: 'lost' })
    },
    unsaved: () => (pending() ? latest : null),
    reset(content) {
      clearTimer()
      latest = content
      saved = content
      if (state.status !== 'lost') set({ status: 'saved', error: null })
    },
  }
}
