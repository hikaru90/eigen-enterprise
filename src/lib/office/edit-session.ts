import { DriveApiError, driveApi, type DriveItem, type LockHolder, type LockView } from '$lib/drive/api'
import { LockLostError } from '$lib/drive/autosave'
import { randomUuid } from '$lib/random-uuid'

/** The Drive calls an office editor needs (injected in tests). */
export type EditSessionApi = Pick<typeof driveApi, 'acquireLock' | 'heartbeatLock' | 'releaseLock' | 'writeBytes'>

export type EditSessionTimers = { every(fn: () => void, ms: number): unknown; clear(handle: unknown): void }

export type OfficeEditSession = {
  /** Opens the file for editing: `held`, or `locked` by someone (then `takeover` takes it). */
  start(opts?: { takeover?: boolean }): Promise<LockView>
  /**
   * Saves the bytes as this session's revision. Throws LockLostError when
   * this session no longer holds the lock; with `base` (SHA-256 of the
   * content the editor started from) a newer save in between is refused
   * (DriveApiError code `conflict`).
   */
  save(bytes: Uint8Array, opts?: { base?: string }): Promise<DriveItem>
  /** Stops heartbeating and lets the lock go. */
  stop(): Promise<void>
  held(): boolean
}

/**
 * The editing session of one office viewer (PDF, Word, PowerPoint) — the
 * same rules as the Markdown/CSV editor (W-6): the lock is taken when the
 * person starts editing, kept by a heartbeat every `heartbeatMs`, and lost
 * when someone takes over (`onLost` says who; the viewer keeps its unsaved
 * work on screen). Saves go through the Drive's binary write, one revision
 * per session.
 */
export function createOfficeEditSession(opts: {
  fileId: string
  heartbeatMs: number
  onLost?: (holder: LockHolder | null) => void
  api?: EditSessionApi
  timers?: EditSessionTimers
  sessionId?: string
}): OfficeEditSession {
  const api = opts.api ?? driveApi
  const timers: EditSessionTimers = opts.timers ?? {
    every: (fn, ms) => setInterval(fn, ms),
    clear: (h) => clearInterval(h as ReturnType<typeof setInterval>),
  }
  const session = opts.sessionId ?? randomUuid()
  let holding = false
  let beat: unknown = null

  function lose(holder: LockHolder | null) {
    holding = false
    if (beat !== null) timers.clear(beat)
    beat = null
    opts.onLost?.(holder)
  }

  async function heartbeat() {
    if (!holding) return
    const view = await api.heartbeatLock(opts.fileId, session)
    if (view.state === 'locked') lose(view.holder)
  }

  return {
    async start({ takeover = false } = {}) {
      const view = await api.acquireLock(opts.fileId, session, takeover)
      holding = view.state === 'held'
      if (holding && beat === null) beat = timers.every(() => void heartbeat(), opts.heartbeatMs)
      return view
    },
    async save(bytes, saveOpts) {
      if (!holding) throw new LockLostError('This file is not open for editing in this tab.')
      try {
        const out = saveOpts?.base
          ? await api.writeBytes(opts.fileId, bytes, session, saveOpts.base)
          : await api.writeBytes(opts.fileId, bytes, session)
        return out.file
      } catch (err) {
        if (err instanceof DriveApiError && err.code === 'locked') {
          lose(err.holder)
          throw new LockLostError(err.message, err.holder?.userId ?? null)
        }
        throw err
      }
    },
    async stop() {
      const was = holding
      holding = false
      if (beat !== null) timers.clear(beat)
      beat = null
      if (was) await api.releaseLock(opts.fileId, session)
    },
    held: () => holding,
  }
}
