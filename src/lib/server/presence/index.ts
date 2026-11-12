import { InCallWatcher } from './calls-watch'
import { PresenceTracker } from './tracker'

export { PresenceTracker, type Presence, type PresenceStatus, type HeartbeatState } from './tracker'

/**
 * This os process's presence (plan/contribute-round-3.md decision 4): in
 * memory, fed by heartbeats (POST /api/messages/presence) and by the Calls
 * module's live state; delivered on the Messages live feed. Nothing is
 * stored, so a restart resets everyone to offline until their next heartbeat
 * (≤ 25 s later).
 *
 * Blue-green deploys run two processes for a moment, each with its own
 * presence: a heartbeat lands on one of them. That settles as soon as the
 * proxy has switched to the new slot (its next heartbeat) — not worth a
 * shared store for "online now".
 */

const SWEEP_MS = 15_000
/** Members joining/leaving, and calls whose end was not heard. */
const REFRESH_MS = 60_000

let started: Promise<PresenceTracker> | null = null

async function companyMemberIds(): Promise<string[]> {
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  return (await dbMemberStore.listMembers()).map((m) => m.id)
}

export function presence(): Promise<PresenceTracker> {
  started ??= (async () => {
    const tracker = new PresenceTracker(() => new Date())
    const { liveCallsHub, liveCallsService } = await import('../../../../modules/index')
    const [hub, service] = await Promise.all([liveCallsHub(), liveCallsService()])
    const watcher = new InCallWatcher({ hub, service }, (ids) => tracker.setInCall(ids))
    await watcher.follow(await companyMemberIds())
    setInterval(() => tracker.sweep(), SWEEP_MS).unref()
    setInterval(() => {
      ;(async () => {
        await watcher.follow(await companyMemberIds())
        await watcher.reconcile()
      })().catch((err) => console.error('[presence] refreshing members / calls failed', err))
    }, REFRESH_MS).unref()
    return tracker
  })().catch((err) => {
    started = null
    throw err
  })
  return started
}
