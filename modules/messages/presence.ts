import { HEARTBEAT_STATES, type HeartbeatState, type Presence, type PresenceTracker } from '$lib/server/presence/tracker'
import { MessagesError, type MessagesDeps } from './service'

/**
 * Presence in Messages (plan/contribute-round-3.md W5): company members see
 * each other's status — nobody else. The tracker is the os process's
 * in-memory presence ($lib/server/presence); this file is Messages' rules
 * around it: who may report, what a heartbeat looks like, and what one
 * viewer's live feed (/api/messages/stream, `event: presence`) carries.
 */

export type PresencePort = Pick<PresenceTracker, 'heartbeat' | 'setDoNotDisturb' | 'get' | 'list' | 'subscribe'>

/** `replace`: the whole company (on every (re)connect); otherwise only who changed. */
export type PresenceFrame = { people: Presence[]; replace: boolean }

export type PresenceStream = {
  /** Sends the snapshot, then every change, until the returned stop is called. */
  start(send: (f: PresenceFrame) => void): Promise<() => void>
}

/** How often an open feed re-checks that its viewer is still in the company. */
export const VIEWER_RECHECK_MS = 30_000

/** A tab's random id (crypto.randomUUID() in the page). */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/

async function requireMember(d: MessagesDeps, userId: string): Promise<void> {
  if (!(await d.directory.role(userId))) throw new MessagesError('forbidden', 'only members of the company have a presence')
}

/** A heartbeat { clientId, state: active | idle | gone } from one of the person's tabs. */
export async function reportPresence(d: MessagesDeps, p: PresencePort, actorId: string, body: Record<string, unknown>): Promise<void> {
  const { clientId, state } = body
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    throw new MessagesError('invalid', 'clientId must be 8–64 letters, digits, - or _')
  }
  if (typeof state !== 'string' || !(HEARTBEAT_STATES as readonly string[]).includes(state)) {
    throw new MessagesError('invalid', `state must be one of ${HEARTBEAT_STATES.join(', ')}`)
  }
  await requireMember(d, actorId)
  p.heartbeat(actorId, clientId, state as HeartbeatState)
}

/** { doNotDisturb: boolean } — the person's own toggle. */
export async function setDoNotDisturb(d: MessagesDeps, p: PresencePort, actorId: string, body: Record<string, unknown>): Promise<Presence> {
  if (typeof body.doNotDisturb !== 'boolean') throw new MessagesError('invalid', 'doNotDisturb must be true or false')
  await requireMember(d, actorId)
  return p.setDoNotDisturb(actorId, body.doNotDisturb)
}

/**
 * The presence part of a viewer's live feed, or null when they are not in the
 * company. The tracker is loaded in start(): if presence cannot start, the
 * stream reports that and messages keep flowing.
 */
export async function presenceStreamFor(
  d: MessagesDeps,
  tracker: () => Promise<PresencePort>,
  viewerId: string,
): Promise<PresenceStream | null> {
  if (!(await d.directory.role(viewerId))) return null
  return {
    async start(send) {
      const [p, people] = await Promise.all([tracker(), d.directory.listPeople()])
      const ids = people.map((person) => person.id)
      // Subscribe and snapshot in the same tick: no change falls between them.
      const unsubscribe = p.subscribe((changed) => send({ people: changed, replace: false }))
      send({ people: p.list(ids), replace: true })
      const recheck = setInterval(() => {
        d.directory
          .role(viewerId)
          .then((role) => {
            if (!role) stop()
          })
          .catch((err: unknown) => console.error('[messages] presence viewer re-check failed', { viewerId, err }))
      }, VIEWER_RECHECK_MS)
      const stop = () => {
        unsubscribe()
        clearInterval(recheck)
      }
      return stop
    },
  }
}
