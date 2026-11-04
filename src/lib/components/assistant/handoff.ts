/**
 * The onboarding hand-off contract (phase-2e, kept by polish P-1): when the
 * welcome wizard completes, it marks the agent's greeting turn as pending; the
 * assistant panel takes the mark once it is up (the shell mounts after the
 * full-screen first run ends) and streams the greeting into the panel.
 *
 * The mark lives in sessionStorage so it survives the remount between the
 * wizard and the shell; where storage is unavailable an in-memory flag in this
 * module (shared by the page and the shell) carries it instead.
 */

export const HANDOFF_PENDING_KEY = 'ee.onboarding-handoff-pending'

let pendingInMemory = false

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const session = (): StorageLike => sessionStorage

export function markHandoffPending(storage: () => StorageLike = session): void {
  try {
    storage().setItem(HANDOFF_PENDING_KEY, '1')
  } catch {
    pendingInMemory = true
  }
}

/** Exactly once: whoever takes the pending mark starts the greeting. */
export function takePendingHandoff(storage: () => StorageLike = session): boolean {
  let pending = pendingInMemory
  pendingInMemory = false
  try {
    const store = storage()
    if (store.getItem(HANDOFF_PENDING_KEY) === '1') {
      store.removeItem(HANDOFF_PENDING_KEY)
      pending = true
    }
  } catch {
    // storage unavailable: the in-memory flag decides
  }
  return pending
}
