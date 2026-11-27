import { parseWhereReport, type WhereItem, type WhereReport, type WhereView } from '$lib/presence/where'
import { HEARTBEAT_STATES, type HeartbeatState, type Presence, type PresenceTracker } from '$lib/server/presence/tracker'
import { canUse, conversationTitle, isId, MessagesError, type MessagesDeps } from './service'

/**
 * Presence in Messages (plan/contribute-round-3.md W5): company members see
 * each other's status — nobody else. The tracker is the os process's
 * in-memory presence ($lib/server/presence); this file is Messages' rules
 * around it: who may report, what a heartbeat looks like, and what one
 * viewer's live feed (/api/messages/stream and /api/messages/presence/stream,
 * `event: presence`) carries.
 *
 * Where someone is working (plan/phase-multiplayer-presence.md) is filtered
 * per viewer and fails closed: the area goes to every member; the item (and
 * the path, which carries its id) only to a viewer who may open it
 * themselves — a conversation by Messages' own `canUse` (a DM only to its
 * participants), a Drive file/folder by Drive's access check (through
 * WhereDrivePort, Drive's public seam). Switched off ("Share where I am"),
 * nobody else sees the place. Co-workers have no where.
 */

export type PresencePort = Pick<
  PresenceTracker,
  'heartbeat' | 'setDoNotDisturb' | 'setShareWhere' | 'get' | 'list' | 'subscribe'
>

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

/** Drive items as one viewer may open them (Drive's own access check; live: Drive's public seam). */
export type WhereDrivePort = {
  /** The item's name when `viewerId` may open it (view access, not in the bin), else null. */
  itemName(viewerId: string, kind: 'drive_file' | 'drive_folder', id: string): Promise<string | null>
}

/** Where "Share where I am" is stored (user_preference.share_where). */
export type ShareWherePort = { set(userId: string, on: boolean): Promise<void> }

/** A person's (tracker) or a co-worker's presence as the feed carries it, where already filtered for the viewer. */
export type PresenceEntry = Omit<Presence, 'status' | 'where'> & {
  status: Presence['status'] | CoworkerPresenceStatus
  where: WhereView | null
}

/** `replace`: the whole company (on every (re)connect); otherwise only who changed. */
export type PresenceFrame = { people: PresenceEntry[]; replace: boolean }

export type PresenceStream = {
  /** Sends the snapshot, then every change, until the returned stop is called. */
  start(send: (f: PresenceFrame) => void): Promise<() => void>
}

/** How often an open feed re-checks that its viewer is still in the company (and what they may open). */
export const VIEWER_RECHECK_MS = 30_000

/** How long one viewer's answer about one item (may they open it, its title) is remembered. */
export const WHERE_CACHE_MS = 30_000

/** A tab's random id (crypto.randomUUID() in the page). */
const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/

async function requireMember(d: MessagesDeps, userId: string): Promise<void> {
  if (!(await d.directory.role(userId))) throw new MessagesError('forbidden', 'only members of the company have a presence')
}

/**
 * A heartbeat { clientId, state: active | idle | gone, where } from one of
 * the person's tabs (`where`: src/lib/presence/where.ts; a closing tab may
 * send null). Answers their own presence, unfiltered: the shell shows it in
 * the main nav on every page (Contribute e4ef6be1) without opening a feed.
 */
export async function reportPresence(d: MessagesDeps, p: PresencePort, actorId: string, body: Record<string, unknown>): Promise<Presence> {
  const { clientId, state } = body
  if (typeof clientId !== 'string' || !CLIENT_ID.test(clientId)) {
    throw new MessagesError('invalid', 'clientId must be 8–64 letters, digits, - or _')
  }
  if (typeof state !== 'string' || !(HEARTBEAT_STATES as readonly string[]).includes(state)) {
    throw new MessagesError('invalid', `state must be one of ${HEARTBEAT_STATES.join(', ')}`)
  }
  if (!('where' in body)) throw new MessagesError('invalid', 'where is required (null only when the tab is closing)')
  let where: WhereReport | null = null
  if (!(state === 'gone' && body.where === null)) {
    try {
      where = parseWhereReport(body.where)
    } catch (err) {
      throw new MessagesError('invalid', err instanceof Error ? err.message : String(err))
    }
  }
  await requireMember(d, actorId)
  p.heartbeat(actorId, clientId, state as HeartbeatState, where)
  return p.get(actorId)
}

/** { doNotDisturb: boolean } — the person's own toggle. */
export async function setDoNotDisturb(d: MessagesDeps, p: PresencePort, actorId: string, body: Record<string, unknown>): Promise<Presence> {
  if (typeof body.doNotDisturb !== 'boolean') throw new MessagesError('invalid', 'doNotDisturb must be true or false')
  await requireMember(d, actorId)
  return p.setDoNotDisturb(actorId, body.doNotDisturb)
}

/** { shareWhere: boolean } — the person's own "Share where I am" switch: stored, then told to the tracker. */
export async function setShareWhere(
  d: MessagesDeps,
  p: PresencePort,
  store: ShareWherePort,
  actorId: string,
  body: Record<string, unknown>,
): Promise<Presence> {
  if (typeof body.shareWhere !== 'boolean') throw new MessagesError('invalid', 'shareWhere must be true or false')
  await requireMember(d, actorId)
  await store.set(actorId, body.shareWhere)
  return p.setShareWhere(actorId, body.shareWhere)
}

/** One viewer's view of someone's place (null: nowhere to show). */
export type WhereFilter = (p: Presence) => Promise<WhereView | null>

/**
 * What `viewerId` is shown of a person's place: nothing when the person is
 * nowhere or (someone else) switched sharing off; the area always; the item
 * with its title and the path only when the viewer may open the item. Each
 * item's answer is remembered for WHERE_CACHE_MS (a heartbeat must not cost
 * a lookup per viewer); a failed lookup hides the item, logged, uncached.
 */
export function whereFilter(
  d: MessagesDeps,
  drive: WhereDrivePort,
  viewerId: string,
  opts: { now?: () => number } = {},
): WhereFilter {
  const now = opts.now ?? Date.now
  const cache = new Map<string, { title: string | null; at: number }>()

  const lookup = async (item: WhereItem): Promise<string | null> => {
    if (item.kind === 'conversation') {
      const c = isId(item.id) ? await d.store.getConversation(item.id) : null
      if (!c || !(await canUse(d, viewerId, c))) return null
      return conversationTitle(d, viewerId, c)
    }
    return drive.itemName(viewerId, item.kind, item.id)
  }

  const titleOf = async (item: WhereItem): Promise<string | null> => {
    const key = `${item.kind}:${item.id}`
    const hit = cache.get(key)
    if (hit && now() - hit.at < WHERE_CACHE_MS) return hit.title
    try {
      const title = await lookup(item)
      cache.set(key, { title, at: now() })
      return title
    } catch (err) {
      console.error('[messages] checking what a viewer may see of a place failed; hidden', { viewerId, item, err })
      return null
    }
  }

  return async (p) => {
    const w = p.where
    if (!w || (p.userId !== viewerId && !p.shareWhere)) return null
    if (!w.item) return { area: w.area, path: w.path, item: null }
    const title = await titleOf(w.item)
    if (title === null) return { area: w.area, path: null, item: null }
    return { area: w.area, path: w.path, item: { ...w.item, title } }
  }
}

const coworkerEntry = (userId: string, s: Map<string, CoworkerPresenceStatus>): PresenceEntry => ({
  userId,
  status: s.get(userId) ?? 'paused',
  doNotDisturb: false,
  lastSeenAt: null,
  where: null,
  shareWhere: false,
})

/**
 * Everyone's (or one person's) presence as `viewerId` may see it — the read
 * behind messages.presence. Members only; co-workers with their fact status.
 */
export async function presenceFor(
  d: MessagesDeps,
  p: PresencePort,
  drive: WhereDrivePort,
  coworkers: CoworkerPresencePort,
  viewerId: string,
  userId?: string,
): Promise<{ people: PresenceEntry[] }> {
  await requireMember(d, viewerId)
  const people = await d.directory.listPeople()
  const asked = userId === undefined ? people : people.filter((person) => person.id === userId)
  if (asked.length === 0) throw new MessagesError('not_found', `nobody with id ${userId} is in the company`)
  const filter = whereFilter(d, drive, viewerId)
  const statuses = asked.some((person) => person.kind === 'coworker') ? await coworkers.statuses() : new Map()
  const out: PresenceEntry[] = []
  for (const person of asked) {
    if (person.kind === 'coworker') out.push(coworkerEntry(person.id, statuses))
    else {
      const presence = p.get(person.id)
      out.push({ ...presence, where: await filter(presence) })
    }
  }
  return { people: out }
}

/**
 * The presence part of a viewer's live feed, or null when they are not in the
 * company. The tracker is loaded in start(): if presence cannot start, the
 * stream reports that and messages keep flowing. Where is filtered for the
 * viewer (whereFilter); frames go out in order, and a person whose entry
 * looks the same to this viewer (moved between two items they cannot open)
 * is not sent again. Every re-check also re-filters everyone's place, so
 * access lost (or gained) shows without the person moving.
 */
export async function presenceStreamFor(
  d: MessagesDeps,
  tracker: () => Promise<PresencePort>,
  viewerId: string,
  coworkers: CoworkerPresencePort,
  drive: WhereDrivePort,
): Promise<PresenceStream | null> {
  if (!(await d.directory.role(viewerId))) return null
  return {
    async start(send) {
      const [p, people] = await Promise.all([tracker(), d.directory.listPeople()])
      const coworkerIds = new Set(people.filter((person) => person.kind === 'coworker').map((person) => person.id))
      const humanIds = people.filter((person) => !coworkerIds.has(person.id)).map((person) => person.id)
      const filter = whereFilter(d, drive, viewerId)
      const sent = new Map<string, string>()
      const toEntry = async (x: Presence): Promise<PresenceEntry> => ({ ...x, where: await filter(x) })
      let told = await coworkers.statuses()
      let stopped = false
      // Every send runs through one chain: the snapshot first, then changes in the order they happened.
      let chain = Promise.resolve()
      const enqueue = (work: () => Promise<void>, what: string) => {
        chain = chain.then(work).catch((err: unknown) => console.error(`[messages] ${what} failed`, { viewerId, err }))
      }
      const sendChanged = async (changed: readonly Presence[]) => {
        const entries = await Promise.all(changed.map(toEntry))
        if (stopped) return
        const fresh = entries.filter((e) => sent.get(e.userId) !== JSON.stringify(e))
        for (const e of fresh) sent.set(e.userId, JSON.stringify(e))
        if (fresh.length) send({ people: fresh, replace: false })
      }
      const onCoworkers = () =>
        enqueue(async () => {
          const now = await coworkers.statuses()
          if (stopped) return
          const changed = [...coworkerIds].filter((id) => (now.get(id) ?? 'paused') !== (told.get(id) ?? 'paused'))
          told = now
          if (changed.length) send({ people: changed.map((id) => coworkerEntry(id, now)), replace: false })
        }, 'co-worker presence')
      // Subscribe and snapshot in the same tick: no change falls between them.
      const unsubscribeTracker = p.subscribe((changed) => {
        const humans = changed.filter((c) => !coworkerIds.has(c.userId))
        if (humans.length) enqueue(() => sendChanged(humans), 'presence change')
      })
      const unsubscribeCoworkers = coworkers.subscribe(onCoworkers)
      const unsubscribe = () => {
        stopped = true
        unsubscribeTracker()
        unsubscribeCoworkers()
      }
      const snapshot = new Map(p.list(humanIds).map((x) => [x.userId, x]))
      enqueue(async () => {
        const entries: PresenceEntry[] = []
        for (const person of people) {
          const x = snapshot.get(person.id)
          entries.push(x ? await toEntry(x) : coworkerEntry(person.id, told))
        }
        if (stopped) return
        for (const e of entries) if (!coworkerIds.has(e.userId)) sent.set(e.userId, JSON.stringify(e))
        send({ people: entries, replace: true })
      }, 'presence snapshot')
      await chain
      const recheck = setInterval(() => {
        d.directory
          .role(viewerId)
          .then((role) => {
            if (!role) return stop()
            const placed = p.list(humanIds).filter((x) => x.where !== null)
            if (placed.length) enqueue(() => sendChanged(placed), 'presence re-check')
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
