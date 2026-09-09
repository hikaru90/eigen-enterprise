import type { RecapDeps } from './types'
import { deliverRecap, type DeliverRecapResult } from './deliver'
import { countPendingApprovals, listRecapWindowEvents, type RecapWindow } from './query'
import { summarizeEvents } from './summarize'

/**
 * Scheduling: run-once recap execution + an in-memory once-per-day guard.
 * src/lib/server/scheduled-tasks is a per-user consolidation registry (pg_cron
 * + job queue) with no generic module-level cron registration point, so the
 * recap owns its guard here and the tick cadence belongs to the composition
 * root (poll loop / cron caller). The window is a rolling 24h ending at the
 * run instant; the guard keys on the UTC calendar day.
 */

export type RecapRunResult = DeliverRecapResult & {
  window: RecapWindow
  pendingApprovals: number
}

/** Run one recap now: query the last-24h window, summarize, deliver. */
export async function runDailyRecap(deps: RecapDeps, now: Date): Promise<RecapRunResult> {
  const window: RecapWindow = {
    start: new Date(now.getTime() - 24 * 60 * 60 * 1000),
    end: now,
  }
  const events = await listRecapWindowEvents(deps.db, window)
  const pendingApprovals = await countPendingApprovals(deps.db)
  const summary = summarizeEvents(events, { pendingApprovals })
  const delivered = await deliverRecap(deps, { summary, window, events })
  return { ...delivered, window, pendingApprovals }
}

/** UTC calendar-day key: two ticks on the same day share one guard value. */
export function recapDayKey(now: Date): string {
  return now.toISOString().slice(0, 10)
}

export type RecapSchedulerDeps = {
  /** Activation gate — the recap module must be active (fail closed). */
  isActive: () => Promise<boolean>
  /** The actual run (normally `runDailyRecap` bound to RecapDeps); injectable for tests. */
  runOnce: (now: Date) => Promise<RecapRunResult>
}

export type RecapScheduler = {
  /**
   * Runs at most once per UTC day, and only while the module is active.
   * The day guard is set only after a successful run, so a failed delivery
   * (e.g. telegram down) is retried on the next tick of the same day.
   */
  maybeRun(now: Date): Promise<boolean>
  /** Current guard value (null until the first successful run). */
  lastRunDay(): string | null
}

export function createRecapScheduler(deps: RecapSchedulerDeps): RecapScheduler {
  let lastDay: string | null = null
  return {
    async maybeRun(now: Date): Promise<boolean> {
      if (!(await deps.isActive())) return false
      const day = recapDayKey(now)
      if (lastDay === day) return false
      await deps.runOnce(now)
      lastDay = day
      return true
    },
    lastRunDay: () => lastDay,
  }
}
