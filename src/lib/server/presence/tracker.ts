/**
 * Presence (Contribute board 119f59a4, plan/contribute-round-3.md W5): who is
 * online right now, so nobody has to guess when they'll get an answer. Pure
 * and in memory: one tracker per os process, fed by client heartbeats and by
 * the Calls module's live state. Nothing is stored — a restart resets
 * everyone to offline (decision 4). No history is kept beyond each person's
 * latest heartbeat time ("active 2 h ago").
 *
 * Status, strongest first:
 *   in_call  — in the room of a live call (Calls' truth; no heartbeat needed)
 *   dnd      — connected, and they switched "Do not disturb" on themselves
 *   online   — a tab/device sent an active heartbeat within the window
 *   away     — connected, but every tab is hidden or idle
 *   offline  — no heartbeat within the window
 */

/** No heartbeat for this long = offline (hidden tabs are throttled to about one timer a minute). */
export const OFFLINE_AFTER_MS = 90_000

/** A person's tabs/devices remembered at once; the stalest goes first. */
export const MAX_CLIENTS_PER_PERSON = 8

export const HEARTBEAT_STATES = ['active', 'idle', 'gone'] as const
/** What one tab says: in use, hidden/idle, or closing. */
export type HeartbeatState = (typeof HEARTBEAT_STATES)[number]

export const PRESENCE_STATUSES = ['in_call', 'dnd', 'online', 'away', 'offline'] as const
export type PresenceStatus = (typeof PRESENCE_STATUSES)[number]

export type Presence = {
  userId: string
  status: PresenceStatus
  /** Their own toggle; kept while offline so it applies again when they're back. */
  doNotDisturb: boolean
  /** The latest heartbeat this process heard (null: none since it started). */
  lastSeenAt: string | null
}

type Client = { at: number; active: boolean }
type Person = { clients: Map<string, Client>; lastSeenAt: number | null; doNotDisturb: boolean }

const keyOf = (p: Presence) => `${p.status}|${p.doNotDisturb}`
const OFFLINE_KEY = 'offline|false'

export class PresenceTracker {
  readonly #people = new Map<string, Person>()
  #inCall = new Set<string>()
  /** What subscribers were last told per person (absent = offline, no DND). */
  readonly #told = new Map<string, string>()
  readonly #listeners = new Set<(changed: Presence[]) => void>()

  constructor(private readonly now: () => Date) {}

  heartbeat(userId: string, clientId: string, state: HeartbeatState): void {
    const at = this.now().getTime()
    const person = this.#person(userId)
    person.lastSeenAt = at
    if (state === 'gone') person.clients.delete(clientId)
    else {
      person.clients.delete(clientId) // re-insert: Map order = heartbeat order
      person.clients.set(clientId, { at, active: state === 'active' })
      while (person.clients.size > MAX_CLIENTS_PER_PERSON) person.clients.delete(person.clients.keys().next().value!)
    }
    this.#announce([userId])
  }

  setDoNotDisturb(userId: string, on: boolean): Presence {
    this.#person(userId).doNotDisturb = on
    this.#announce([userId])
    return this.get(userId)
  }

  /** Everyone in the room of a live call right now (replaces the previous set). */
  setInCall(userIds: Iterable<string>): void {
    const next = new Set(userIds)
    const touched = [...new Set([...this.#inCall, ...next])]
    this.#inCall = next
    this.#announce(touched)
  }

  get(userId: string): Presence {
    const person = this.#people.get(userId)
    const lastSeenAt = person?.lastSeenAt != null ? new Date(person.lastSeenAt).toISOString() : null
    const doNotDisturb = person?.doNotDisturb ?? false
    const status = this.#status(userId, person, doNotDisturb)
    return { userId, status, doNotDisturb, lastSeenAt }
  }

  list(userIds: readonly string[]): Presence[] {
    return userIds.map((id) => this.get(id))
  }

  /** Re-evaluates everyone it knows (heartbeats run out without an event); tells subscribers what changed. */
  sweep(): void {
    this.#announce([...new Set([...this.#people.keys(), ...this.#inCall, ...this.#told.keys()])])
  }

  /** Called with the people whose status or DND changed; returns unsubscribe. */
  subscribe(fn: (changed: Presence[]) => void): () => void {
    this.#listeners.add(fn)
    return () => this.#listeners.delete(fn)
  }

  #person(userId: string): Person {
    let p = this.#people.get(userId)
    if (!p) {
      p = { clients: new Map(), lastSeenAt: null, doNotDisturb: false }
      this.#people.set(userId, p)
    }
    return p
  }

  #status(userId: string, person: Person | undefined, doNotDisturb: boolean): PresenceStatus {
    if (this.#inCall.has(userId)) return 'in_call'
    if (!person) return 'offline'
    const cutoff = this.now().getTime() - OFFLINE_AFTER_MS
    for (const [id, c] of person.clients) if (c.at <= cutoff) person.clients.delete(id)
    if (person.clients.size === 0) return 'offline'
    if (doNotDisturb) return 'dnd'
    return [...person.clients.values()].some((c) => c.active) ? 'online' : 'away'
  }

  #announce(userIds: readonly string[]): void {
    const changed: Presence[] = []
    for (const id of userIds) {
      const p = this.get(id)
      const key = keyOf(p)
      if ((this.#told.get(id) ?? OFFLINE_KEY) === key) continue
      if (key === OFFLINE_KEY) this.#told.delete(id)
      else this.#told.set(id, key)
      changed.push(p)
    }
    if (changed.length === 0) return
    for (const fn of [...this.#listeners]) {
      try {
        fn(changed)
      } catch (err) {
        console.error('[presence] a subscriber failed', err)
      }
    }
  }
}
