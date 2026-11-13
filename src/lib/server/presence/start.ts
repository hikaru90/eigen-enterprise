import type { InCallWatcher } from './calls-watch'
import { PresenceTracker } from './tracker'

export type PresenceStartDeps = {
  now: () => Date
  /** The "in a call" watcher, fed into the tracker. */
  watcher: (onChange: (inCall: Set<string>) => void) => Pick<InCallWatcher, 'follow' | 'reconcile'>
  memberIds: () => Promise<string[]>
  onError: (err: unknown) => void
  sweepMs?: number
  refreshMs?: number
}

const SWEEP_MS = 15_000
/** Members joining/leaving, and calls whose end was not heard. */
const REFRESH_MS = 60_000

/**
 * The tracker is ready at once; following the members' calls ("in a call")
 * runs in the background and again every refresh. A heartbeat never waits
 * for it: each one holds a request-reserved DB connection while it waits,
 * and following every member needs the same pool — enough waiting
 * heartbeats starved the follow and hung the whole server. A failed follow
 * is reported through onError and tried again on the next refresh.
 */
export async function startPresence(d: PresenceStartDeps): Promise<PresenceTracker> {
  const tracker = new PresenceTracker(d.now)
  const watcher = d.watcher((ids) => tracker.setInCall(ids))
  let first = true
  const refresh = async () => {
    await watcher.follow(await d.memberIds())
    if (!first) await watcher.reconcile()
    first = false
  }
  refresh().catch(d.onError)
  setInterval(() => tracker.sweep(), d.sweepMs ?? SWEEP_MS).unref()
  setInterval(() => refresh().catch(d.onError), d.refreshMs ?? REFRESH_MS).unref()
  return tracker
}
