/**
 * Edit locks (plan/phase-workspace.md W-6, co-editing v1): one editor at a
 * time per Markdown/CSV file. A lock belongs to one editor *session* (a
 * browser tab: a random id), not just a person, so a second tab of the same
 * person is a second editor too. The holder heartbeats; a lock whose
 * heartbeat is older than the TTL is free. Anyone with edit access may take
 * over; the previous holder learns it on their next heartbeat or save
 * (`lost`). Rows live in drive_edit_lock (migration 0110).
 */

export type EditLock = { fileId: string; userId: string; sessionId: string; acquiredAt: Date; heartbeatAt: Date }

export type EditLockStore = {
  get(fileId: string): Promise<EditLock | null>
  /**
   * Atomically writes `lock` when the file has no lock, the current one is
   * the same session, it went stale (heartbeat before `staleBefore`), or
   * `force` (a takeover). Returns whatever lock holds afterwards.
   */
  claim(lock: EditLock, opts: { staleBefore: Date; force: boolean }): Promise<EditLock>
  /** Refreshes the heartbeat when `sessionId` still holds the lock; false otherwise. */
  touch(fileId: string, sessionId: string, at: Date): Promise<boolean>
  /** Drops the lock when `sessionId` holds it. */
  release(fileId: string, sessionId: string): Promise<void>
}

/** A heartbeat every 15 s keeps a lock; 45 s of silence (closed tab, lost network) frees it. */
export const LOCK_TTL_MS = 45_000
export const LOCK_HEARTBEAT_MS = 15_000

export type LockHolder = { userId: string; sessionId: string; since: Date }
export type LockStatus = { state: 'held'; lock: EditLock } | { state: 'locked'; holder: LockHolder } | { state: 'free' }

export function isLive(lock: EditLock | null, now: Date, ttlMs = LOCK_TTL_MS): lock is EditLock {
  return !!lock && now.getTime() - lock.heartbeatAt.getTime() < ttlMs
}

export function holderOf(lock: EditLock): LockHolder {
  return { userId: lock.userId, sessionId: lock.sessionId, since: lock.acquiredAt }
}

export function memoryEditLockStore(): EditLockStore {
  const locks = new Map<string, EditLock>()
  return {
    async get(fileId) {
      const l = locks.get(fileId)
      return l ? { ...l } : null
    },
    async claim(lock, { staleBefore, force }) {
      const cur = locks.get(lock.fileId)
      if (!cur || force || cur.sessionId === lock.sessionId || cur.heartbeatAt < staleBefore) {
        const keepSince = cur && cur.sessionId === lock.sessionId ? cur.acquiredAt : lock.acquiredAt
        locks.set(lock.fileId, { ...lock, acquiredAt: keepSince })
      }
      return { ...locks.get(lock.fileId)! }
    },
    async touch(fileId, sessionId, at) {
      const cur = locks.get(fileId)
      if (!cur || cur.sessionId !== sessionId) return false
      locks.set(fileId, { ...cur, heartbeatAt: at })
      return true
    },
    async release(fileId, sessionId) {
      if (locks.get(fileId)?.sessionId === sessionId) locks.delete(fileId)
    },
  }
}
