/**
 * "The co-workers changed" (create, update, enable, disable, remove), in this
 * process: the coworkers.* tools announce every successful change here, and
 * the co-worker turns (turns.ts, wired at boot) reload the runtime's agent
 * configs and the trigger subscriptions. A turn reloads the configs from the
 * database before it runs as well, so a change made through another app
 * process is in effect on its next turn here too.
 */

type Listener = () => void | Promise<void>

const listeners = new Set<Listener>()

/** Subscribes to co-worker changes; returns the unsubscribe. */
export function onCoworkersChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/**
 * Tells every listener the co-workers changed. A listener that fails is logged
 * loud and never fails the change that was already committed.
 */
export function notifyCoworkersChanged(): void {
  for (const listener of [...listeners]) {
    Promise.resolve()
      .then(listener)
      .catch((err: unknown) => console.error('[coworkers] reacting to a co-worker change failed', err))
  }
}
