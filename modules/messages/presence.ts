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

/**
 * An AI co-worker's presence, from facts (Contribute 14aea69d), never a
 * heartbeat: switched on = available (it answers whenever it is asked), busy
 * while one of its turns is writing, paused when switched off or removed.
 */
export const COWORKER_PRESENCE_STATUSES = ['available', 'busy', 'paused'] as const
export type CoworkerPresenceStatus = (typeof COWORKER_PRESENCE_STATUSES)[number]

export type CoworkerPresencePort = {
  /** Each co-worker's status by user id (absent: removed, shown as paused). */
  statuses(): Promise<Map<string, CoworkerPresenceStatus>>
  /** Called when a status may have changed (switched on/off, a turn started or ended); returns unsubscribe. */
  subscribe(onChange: () => void): () => void
}

/** A person's (tracker) or a co-worker's presence as the feed carries it. */
export type PresenceEntry = Omit<Presence, 'status'> & { status: Presence['status'] | CoworkerPresenceStatus }

/** `replace`: the whole company (on every (re)connect); otherwise only who changed. */
export type PresenceFrame = { people: PresenceEntry[]; replace: boolean }

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

/**
 * A heartbeat { clientId, state: active | idle | gone } from one of the
 * person's tabs. Answers their own presence: the shell shows it in the main
 * nav on every page (Contribute e4ef6be1) without opening the Messages feed.
 */
export async function reportPresence(d: MessagesDeps, p: PresencePort, actorId: string, body: Record<string, unknown>): Promise<Presence> {
  const { clientId, state } = body
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    throw new MessagesError('invalid', 'clientId must be 8–64 letters, digits, - or _')
  }
  if (typeof state !== 'string' || !(HEARTBEAT_STATES as readonly string[]).includes(state)) {
    throw new MessagesError('invalid', `state must be one of ${HEARTBEAT_STATES.join(', ')}`)
  }
  await requireMember(d, actorId)
  p.heartbeat(actorId, clientId, state as HeartbeatState)
  return p.get(actorId)
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
  coworkers: CoworkerPresencePort,
): Promise<PresenceStream | null> {
  if (!(await d.directory.role(viewerId))) return null
  return {
    async start(send) {
      const [p, people] = await Promise.all([tracker(), d.directory.listPeople()])
      const coworkerIds = new Set(people.filter((person) => person.kind === 'coworker').map((person) => person.id))
      const humanIds = people.filter((person) => !coworkerIds.has(person.id)).map((person) => person.id)
      const entry = (userId: string, s: Map<string, CoworkerPresenceStatus>): PresenceEntry => ({
        userId,
        status: s.get(userId) ?? 'paused',
        doNotDisturb: false,
        lastSeenAt: null,
      })
      let told = await coworkers.statuses()
      let stopped = false
      let chain = Promise.resolve()
      const onCoworkers = () => {
        chain = chain
          .then(async () => {
            const now = await coworkers.statuses()
            if (stopped) return
            const changed = [...coworkerIds].filter((id) => (now.get(id) ?? 'paused') !== (told.get(id) ?? 'paused'))
            told = now
            if (changed.length) send({ people: changed.map((id) => entry(id, now)), replace: false })
          })
          .catch((err: unknown) => console.error('[messages] co-worker presence failed', { viewerId, err }))
      }
      // Subscribe and snapshot in the same tick: no change falls between them.
      const unsubscribeTracker = p.subscribe((changed) => {
        const humans = changed.filter((c) => !coworkerIds.has(c.userId))
        if (humans.length) send({ people: humans, replace: false })
      })
      const unsubscribeCoworkers = coworkers.subscribe(onCoworkers)
      const unsubscribe = () => {
        stopped = true
        unsubscribeTracker()
        unsubscribeCoworkers()
      }
      const humans = new Map(p.list(humanIds).map((x) => [x.userId, x]))
      send({ people: people.map((person) => humans.get(person.id) ?? entry(person.id, told)), replace: true })
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
