/**
 * Telegram long-poll runner for the chat-gateway module.
 *
 * Rationale for a self-contained loop instead of the job-queue ticker
 * (src/lib/server/job-queue/ticker.ts): the ticker fires `tick()` on a fixed
 * interval and tolerates overlap guards, which fits short cron-style work.
 * Telegram long polling BLOCKS server-side for ~pollTimeoutSec per call, so
 * the correct shape is a strictly sequential chain — start the next poll only
 * when the previous one returns — with exponential backoff on transport
 * errors. The offset cursor is held in process memory: at-least-once
 * delivery; a failed cycle leaves the offset untouched so Telegram
 * redelivers the batch after backoff.
 */

export type TelegramGatewayLike = {
  runCycle(offset: number, timeoutSec?: number): Promise<number>
}

export type TelegramLoopDeps = {
  gateway: TelegramGatewayLike
  /** Telegram long-poll timeout in seconds (server-side hold). */
  pollTimeoutSec?: number
  /** Initial backoff after a failed cycle. */
  errorBackoffMs?: number
  /** Upper bound for the exponential backoff. */
  maxErrorBackoffMs?: number
  /**
   * Pause between a finished cycle and the next poll. Degenerate gateways
   * that return instantly (transport bugs, misconfigured polling) would
   * otherwise hot-spin the process; against real long polling the gap is
   * noise next to the 25s server-side hold.
   */
  idleGapMs?: number
}

export type TelegramLoopHandle = {
  /** True while the loop wants to run (including in-flight cycles/backoff). */
  readonly running: boolean
  start(): void
  /** Stops the loop; resolves once the in-flight cycle finishes. Idempotent. */
  stop(): Promise<void>
}

const DEFAULT_POLL_TIMEOUT_SEC = 25
const DEFAULT_ERROR_BACKOFF_MS = 1_000
const DEFAULT_MAX_ERROR_BACKOFF_MS = 30_000
const DEFAULT_IDLE_GAP_MS = 50

export function createTelegramLoop(deps: TelegramLoopDeps): TelegramLoopHandle {
  const pollTimeoutSec = deps.pollTimeoutSec ?? DEFAULT_POLL_TIMEOUT_SEC
  const initialBackoffMs = deps.errorBackoffMs ?? DEFAULT_ERROR_BACKOFF_MS
  const maxBackoffMs = deps.maxErrorBackoffMs ?? DEFAULT_MAX_ERROR_BACKOFF_MS
  const idleGapMs = deps.idleGapMs ?? DEFAULT_IDLE_GAP_MS

  let running = false
  let stopped = false
  /** Resolver for an in-flight sleep; stop() releases it early. */
  let wakeSleep: (() => void) | null = null
  let exited: Promise<void> = Promise.resolve()

  const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeSleep = null
        resolve()
      }, ms)
      wakeSleep = () => {
        clearTimeout(timer)
        wakeSleep = null
        resolve()
      }
    })

  async function run(): Promise<void> {
    let offset = 0
    let backoffMs = initialBackoffMs
    while (!stopped) {
      try {
        offset = await deps.gateway.runCycle(offset, pollTimeoutSec)
        backoffMs = initialBackoffMs
        if (!stopped) await sleep(idleGapMs)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Metadata only — cycle errors carry gateway/transport details, never message content.
        console.warn('[orchestrator.loop] telegram cycle failed; retrying', {
          backoffMs,
          errorPreview: message.slice(0, 200),
        })
        await sleep(backoffMs)
        backoffMs = Math.min(backoffMs * 2, maxBackoffMs)
      }
    }
  }

  return {
    get running(): boolean {
      return running
    },
    start(): void {
      if (running || stopped) return
      running = true
      exited = run()
    },
    stop(): Promise<void> {
      if (stopped) return exited
      stopped = true
      running = false
      wakeSleep?.()
      return exited
    },
  }
}

/** Create and immediately start the loop (the common boot path). */
export function startTelegramLoop(deps: TelegramLoopDeps): TelegramLoopHandle {
  const loop = createTelegramLoop(deps)
  loop.start()
  return loop
}
