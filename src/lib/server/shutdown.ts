/**
 * Prompt exit on SIGTERM/SIGINT (plan/phase-durable.md D3: recovery-on-reopen
 * IS the durable design). adapter-node's own handler stops accepting and waits
 * for every open request — a streaming chat turn or a run-feed SSE never ends
 * on its own, so every restart sat out the SIGKILL timeout. Here the server
 * gets a short grace for ordinary requests, then the process exits.
 *
 * In-flight agent state stays safe: pi-durable commits every step before it is
 * shown and a reopened harness resumes unsettled turns (D9 mirrors their
 * replies); the agent state lock is released so the next owner opens at once.
 */

/** Ordinary (non-streaming) requests get this long to finish after the signal. */
export const SHUTDOWN_GRACE_MS = 2_000

type ProcessLike = {
  once(event: 'SIGTERM' | 'SIGINT', listener: () => void): unknown
  once(event: 'sveltekit:shutdown', listener: () => void): unknown
  exit(code: number): void
}

export type PromptShutdownDeps = {
  process?: ProcessLike
  graceMs?: number
  /** Synchronous last steps before exit (e.g. releasing the agent state lock). */
  beforeExit?: () => void
  log?: (message: string) => void
}

const host = globalThis as { __eePromptShutdown?: boolean }

export function installPromptShutdown(deps: PromptShutdownDeps = {}): void {
  const proc = deps.process ?? (process as unknown as ProcessLike)
  // Once per process (HMR re-evaluates hooks).
  if (!deps.process) {
    if (host.__eePromptShutdown) return
    host.__eePromptShutdown = true
  }
  const graceMs = deps.graceMs ?? SHUTDOWN_GRACE_MS
  const log = deps.log ?? ((message: string) => console.log(message))
  let exiting = false

  const exit = (why: string) => {
    if (exiting) return
    exiting = true
    log(`[shutdown] exiting (${why})`)
    try {
      deps.beforeExit?.()
    } finally {
      proc.exit(0)
    }
  }

  const onSignal = (signal: 'SIGTERM' | 'SIGINT') => () => {
    log(`[shutdown] ${signal}: closing; exit after open requests or ${graceMs}ms`)
    // adapter-node emits this once every request has closed.
    proc.once('sveltekit:shutdown', () => exit('all requests closed'))
    const timer = setTimeout(() => exit(`grace of ${graceMs}ms over; in-flight agent turns resume on reopen`), graceMs)
    ;(timer as { unref?: () => void }).unref?.()
  }
  proc.once('SIGTERM', onSignal('SIGTERM'))
  proc.once('SIGINT', onSignal('SIGINT'))
}
