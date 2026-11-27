import type { InCallWatcher } from './calls-watch'
import { PresenceTracker } from './tracker'

export type PresenceStartDeps = {
  now: () => Date
  /** The "in a call" watcher, fed into the tracker. */
  watcher: (onChange: (inCall: Set<string>) => void) => Pick<InCallWatcher, 'follow' | 'reconcile'>
  memberIds: () => Promise<string[]>
  /** Who switched "Share where I am" off (user_preference.share_where = false). */
  shareWhereOff: () => Promise<string[]>
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
 *
 * Each refresh also reads everyone's "Share where I am" switch (one query;
 * the other blue-green slot's changes arrive this way). Until the first read
 * lands nobody shares where they are.
 */
export async function startPresence(d: PresenceStartDeps): Promise<PresenceTracker> {
  const tracker = new PresenceTracker(d.now)
  const watcher = d.watcher((ids) => tracker.setInCall(ids))
  let first = true
  const follow = async () => {
    await watcher.follow(await d.memberIds())
    if (!first) await watcher.reconcile()
    first = false
  }
  const shareSwitches = async () => {
    const readAt = tracker.shareWhereRevision
    tracker.setShareWhereOff(await d.shareWhereOff(), readAt)
  }
  // Independent: a failed follow never keeps the switches unread, nor the other way round.
  const refresh = () => {
    follow().catch(d.onError)
    shareSwitches().catch(d.onError)
  }
  refresh()
  setInterval(() => tracker.sweep(), d.sweepMs ?? SWEEP_MS).unref()
  setInterval(refresh, d.refreshMs ?? REFRESH_MS).unref()
  return tracker
}
