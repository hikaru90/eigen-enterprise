import { sameWhere, type WhereReport } from '$lib/presence/where'

/**
 * Presence in the Messages page (plan/contribute-round-3.md W5): the views
 * of everyone's status from the live feed (`event: presence` on
 * /api/messages/stream), their labels, and this tab's heartbeat
 * (POST /api/messages/presence). The server decides the status; the page
 * only shows it.
 */

/**
 * People: from heartbeats and calls. AI co-workers (Contribute 14aea69d): from
 * facts, never offline — available while switched on, busy while writing a
 * reply, paused when switched off.
 */
export type PresenceStatus = 'in_call' | 'dnd' | 'online' | 'away' | 'offline' | 'available' | 'busy' | 'paused'

export type PresenceView = {
  userId: string
  status: PresenceStatus
  doNotDisturb: boolean
  lastSeenAt: string | null
}

/** `replace`: the whole company (every (re)connect); otherwise who changed. */
export type PresenceFrame = { people: PresenceView[]; replace: boolean }

export type PresenceMap = Record<string, PresenceView>

export function applyPresence(current: PresenceMap, f: PresenceFrame): PresenceMap {
  const next: PresenceMap = f.replace ? {} : { ...current }
  for (const p of f.people) next[p.userId] = p
  return next
}

/** Someone the feed has not mentioned (yet) is offline. */
export function presenceOf(map: PresenceMap, userId: string): PresenceView {
  return map[userId] ?? { userId, status: 'offline', doNotDisturb: false, lastSeenAt: null }
}

const LABELS: Record<Exclude<PresenceStatus, 'offline'>, string> = {
  in_call: 'In a call',
  dnd: 'Do not disturb',
  online: 'Online',
  away: 'Away',
  available: 'AI co-worker · always available',
  busy: 'Writing a reply',
  paused: 'Paused (switched off)',
}

function lastActive(iso: string, now: Date): string {
  const s = Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / 1000))
  if (s < 60) return 'Active just now'
  if (s < 3600) return `Active ${Math.floor(s / 60)} min ago`
  if (s < 86_400) return `Active ${Math.floor(s / 3600)} h ago`
  const days = Math.floor(s / 86_400)
  return days === 1 ? 'Active yesterday' : `Active ${days} days ago`
}

/** "Online", "Away", "In a call", "Do not disturb", "Active 2 h ago" / "Offline". */
export function presenceLabel(p: PresenceView, now: Date): string {
  if (p.status !== 'offline') return LABELS[p.status]
  return p.lastSeenAt ? lastActive(p.lastSeenAt, now) : 'Offline'
}

// ── this tab's heartbeat ──────────────────────────────────────────────────

/** How often a tab says it is there (the server counts no heartbeat for 90 s as offline). */
export const HEARTBEAT_MS = 25_000
/** No input for this long while visible = away. */
export const IDLE_AFTER_MS = 5 * 60_000

export type HeartbeatState = 'active' | 'idle' | 'gone'

type Events = { addEventListener(t: string, fn: () => void, o?: AddEventListenerOptions): void; removeEventListener(t: string, fn: () => void): void }

/** One beat (POST /api/messages/presence): `where` is null only with `gone`. */
export type HeartbeatBody = { clientId: string; state: HeartbeatState; where: WhereReport | null }

export type HeartbeatEnv = {
  /** This tab's random id (crypto.randomUUID()). */
  clientId: string
  post: (body: HeartbeatBody) => void
  /** Where this tab is right now (plan/phase-multiplayer-presence.md): sidebar entry, path, open item. */
  where: () => WhereReport
  doc: Events & { readonly visibilityState: DocumentVisibilityState }
  win: Events
  now: () => number
}

const INPUT_EVENTS = ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'focus'] as const

/**
 * Active while the tab is visible and someone used it in the last few
 * minutes; idle otherwise; gone when the tab closes. Beats every
 * HEARTBEAT_MS and right away on every change — of state, and of place
 * (moved(): the layout calls it after every navigation and whenever the page
 * declares another open item). Started and stopped by the page (onMount /
 * onDestroy) — explicit events, no effects.
 */
export class PresenceHeartbeat {
  #lastInput = 0
  #sent: HeartbeatState | null = null
  #sentWhere: WhereReport | null = null
  #timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly env: HeartbeatEnv) {}

  get state(): 'active' | 'idle' {
    const { doc, now } = this.env
    return doc.visibilityState === 'visible' && now() - this.#lastInput < IDLE_AFTER_MS ? 'active' : 'idle'
  }

  start(): void {
    if (this.#timer) return
    const { doc, win } = this.env
    this.#lastInput = this.env.now()
    for (const e of INPUT_EVENTS) win.addEventListener(e, this.#onInput, { passive: true })
    win.addEventListener('pagehide', this.#onPageHide)
    win.addEventListener('pageshow', this.#report)
    doc.addEventListener('visibilitychange', this.#report)
    this.#report()
    this.#timer = setInterval(this.#report, HEARTBEAT_MS)
  }

  /** Leaving the app (the nucleus layout is destroyed): stop beating and let the server's window run out. */
  stop(): void {
    if (!this.#timer) return
    const { doc, win } = this.env
    clearInterval(this.#timer)
    this.#timer = undefined
    for (const e of INPUT_EVENTS) win.removeEventListener(e, this.#onInput)
    win.removeEventListener('pagehide', this.#onPageHide)
    win.removeEventListener('pageshow', this.#report)
    doc.removeEventListener('visibilitychange', this.#report)
  }

  /** The tab moved (navigation, another open item): beat right away, unless nothing changed. */
  moved(): void {
    if (!this.#timer) return
    const where = this.env.where()
    if (this.#sent === this.state && sameWhere(this.#sentWhere, where)) return
    this.#send(this.state, where)
  }

  readonly #send = (state: HeartbeatState, where: WhereReport | null = state === 'gone' ? null : this.env.where()) => {
    this.#sent = state
    this.#sentWhere = where
    this.env.post({ clientId: this.env.clientId, state, where })
  }

  readonly #report = () => this.#send(this.state)

  readonly #onInput = () => {
    this.#lastInput = this.env.now()
    if (this.#sent !== 'active' && this.state === 'active') this.#report()
  }

  readonly #onPageHide = () => this.#send('gone')
}
