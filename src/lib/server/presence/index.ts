import type { PresenceTracker } from './tracker'
import { InCallWatcher } from './calls-watch'
import { startPresence } from './start'

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

let started: Promise<PresenceTracker> | null = null

async function companyMemberIds(): Promise<string[]> {
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  return (await dbMemberStore.listMembers()).map((m) => m.id)
}

/** The process's tracker; following calls runs in the background (start.ts), so a heartbeat never waits for it. */
export function presence(): Promise<PresenceTracker> {
  started ??= (async () => {
    const { liveCallsHub, liveCallsService } = await import('../../../../modules/index')
    const [hub, service] = await Promise.all([liveCallsHub(), liveCallsService()])
    return startPresence({
      now: () => new Date(),
      watcher: (onChange) => new InCallWatcher({ hub, service }, onChange),
      memberIds: companyMemberIds,
      onError: (err) => console.error('[presence] following members / calls failed', err),
    })
  })().catch((err) => {
    started = null
    throw err
  })
  return started
}
