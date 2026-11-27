import { getContext, setContext } from 'svelte'
import type { PresenceStatus, PresenceView } from '$lib/messages/presence'
import type { WhereItemKind, WhereReport, WhereView } from './where'

/**
 * Where everyone is working (plan/phase-multiplayer-presence.md): ONE
 * EventSource on /api/messages/presence/stream, opened by the nucleus layout
 * in onMount (only while Messages, which owns presence, is on) and closed on
 * destroy. Each (re)connect opens with the whole company (`replace: true`),
 * then only who changed. The server has already filtered every place for me:
 * an item (and the path carrying its id) only when I may open it myself.
 *
 * Names and pictures come from the people directory (GET
 * /api/messages/people), loaded once — and again when the feed mentions
 * someone it does not know yet (a member who just joined). AI co-workers have
 * no place (yet) and are never shown here.
 *
 * Nothing is swallowed: the server's `presence-error` frame, a stream the
 * browser gave up on and a directory that cannot load are all `error`.
 */

export type PresenceStreamSource = {
  readonly readyState: number
  addEventListener(type: string, fn: (e: Event) => void): void
  close(): void
}

/** One person in the feed: their status, whether they share their place, and the place as I may see it. */
export type CompanyPresenceEntry = PresenceView & { shareWhere: boolean; where: WhereView | null }

export type CompanyPresenceFrame = { people: CompanyPresenceEntry[]; replace: boolean }

/** Someone shown at work somewhere: who, their status (for the dot) and what they have open. */
export type PresencePerson = {
  userId: string
  name: string
  image: string | null
  presence: PresenceView
  where: WhereView
  /** What they have open as I may see it: the item's title, else the area's name; null when neither is known to me. */
  place: string | null
  /** "Anna Müller · Q4 plan.xlsx", "Ben Ode · Drive", or the name alone. */
  label: string
}

type DirectoryPerson = { id: string; name: string; image?: string | null; kind?: 'human' | 'coworker' }

export type CompanyPresenceEnv = {
  /** My user id: I am never among the others. */
  me: string
  open: () => PresenceStreamSource
  fetch: (input: string) => Promise<Response>
  /** The sidebar entry's name for an area id (`Dashboard` for the dashboard); null for one I have no entry for. */
  areaName: (area: string) => string | null
}

const CLOSED = 2
const RETRY_MS = [5_000, 15_000, 60_000]
/** At work right now: offline people have no place, co-workers' statuses are not a place either. */
const AT_WORK: ReadonlySet<PresenceStatus> = new Set(['online', 'away', 'in_call', 'dnd'])
const PEOPLE_ROUTE = '/api/messages/people'

const reason = (err: unknown) => (err instanceof Error ? err.message : String(err))
const byName = (a: PresencePerson, b: PresencePerson) => a.name.localeCompare(b.name)

export class CompanyPresence {
  #entries = $state<Record<string, CompanyPresenceEntry>>({})
  #directory = $state<Record<string, DirectoryPerson> | null>(null)
  #status = $state<'connecting' | 'live' | 'reconnecting'>('connecting')
  #streamError = $state<string | null>(null)
  #directoryError = $state<string | null>(null)
  // Bookkeeping, not view state.
  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- ids already asked for are never rendered
  #asked = new Set<string>()
  #loading = false
  #source: PresenceStreamSource | null = null
  #retry: ReturnType<typeof setTimeout> | undefined
  #failures = 0
  #stopped = true

  constructor(private readonly env: CompanyPresenceEnv) {}

  get status() {
    return this.#status
  }

  /** Why the feed is not (fully) working; null while fine. */
  get error(): string | null {
    return this.#streamError ?? this.#directoryError
  }

  /** Everyone else at work in an area right now, by name. */
  readonly #people = $derived.by((): PresencePerson[] => {
    const directory = this.#directory
    if (!directory) return []
    const out: PresencePerson[] = []
    for (const e of Object.values(this.#entries)) {
      if (e.userId === this.env.me || !AT_WORK.has(e.status) || !e.where) continue
      const person = directory[e.userId]
      if (!person || person.kind === 'coworker') continue
      const where = e.where
      const presence: PresenceView = { userId: e.userId, status: e.status, doNotDisturb: e.doNotDisturb, lastSeenAt: e.lastSeenAt }
      const place = where.item?.title ?? (where.area ? this.env.areaName(where.area) : null)
      out.push({
        userId: e.userId,
        name: person.name,
        image: person.image ?? null,
        presence,
        where,
        place,
        label: place ? `${person.name} · ${place}` : person.name,
      })
    }
    return out.sort(byName)
  })

  /** Everyone else at work somewhere I can name (the collapsed sidebar's count). */
  get others(): PresencePerson[] {
    return this.#people.filter((p) => p.where.area !== null)
  }

  /** The people in one sidebar entry's area (`dashboard` for the dashboard). */
  peopleIn(area: string): PresencePerson[] {
    return this.#people.filter((p) => p.where.area === area)
  }

  /**
   * The people who have one item open right now (a conversation row, a Drive
   * row). The server only sends an item to a viewer who may open it, so a
   * row I can see matches only places I may see.
   */
  peopleOnItem(kind: WhereItemKind, id: string): PresencePerson[] {
    return this.#people.filter((p) => p.where.item?.kind === kind && p.where.item.id === id)
  }

  /** The people on the same item as me — or, when neither of us has one open, on the same page. */
  hereWithMe(mine: WhereReport | null): PresencePerson[] {
    if (!mine) return []
    return this.#people.filter((p) => {
      const theirs = p.where
      if (mine.item) return theirs.item?.kind === mine.item.kind && theirs.item.id === mine.item.id
      return !theirs.item && theirs.path !== null && theirs.path === mine.path
    })
  }

  connect(): void {
    this.#stopped = false
    void this.#loadDirectory()
    this.#start()
  }

  /** Reopen a stream the browser gave up on (visible / online again); a live one is left alone. */
  resume(): void {
    if (this.#stopped || !this.#source || this.#source.readyState !== CLOSED) return
    clearTimeout(this.#retry)
    this.#restart()
  }

  close(): void {
    this.#stopped = true
    clearTimeout(this.#retry)
    this.#source?.close()
    this.#source = null
  }

  /** One frame from the stream (exposed for tests). */
  apply(frame: CompanyPresenceFrame): void {
    const next = frame.replace ? {} : { ...this.#entries }
    for (const p of frame.people) next[p.userId] = p
    this.#entries = next
    this.#streamError = null
    this.#askForStrangers(frame.people)
  }

  async #loadDirectory(): Promise<void> {
    if (this.#loading) return
    this.#loading = true
    try {
      const res = await this.env.fetch(PEOPLE_ROUTE)
      const body = (await res.json().catch(() => null)) as { people?: DirectoryPerson[]; error?: string } | null
      if (!res.ok || !body?.people) {
        throw new Error(body?.error ?? `HTTP ${res.status}`)
      }
      if (this.#stopped) return
      this.#directory = Object.fromEntries(body.people.map((p) => [p.id, p]))
      this.#directoryError = null
    } catch (err) {
      this.#directoryError = `The people list could not be loaded: ${reason(err)}`
      console.error('[presence] people directory:', this.#directoryError)
    } finally {
      this.#loading = false
    }
  }

  /** Someone the directory does not know yet (a member who just joined): reload it, once per person. */
  #askForStrangers(people: CompanyPresenceEntry[]): void {
    const directory = this.#directory
    if (!directory) return
    const strangers = people.filter((p) => p.userId !== this.env.me && !directory[p.userId] && !this.#asked.has(p.userId))
    if (strangers.length === 0) return
    for (const p of strangers) this.#asked.add(p.userId)
    void this.#loadDirectory()
  }

  #start(): void {
    if (this.#stopped) return
    const source = this.env.open()
    this.#source = source
    source.addEventListener('open', () => {
      if (this.#source !== source) return
      this.#failures = 0
      this.#status = 'live'
      this.#streamError = null
    })
    source.addEventListener('error', () => {
      if (this.#source !== source) return
      this.#status = 'reconnecting'
      if (source.readyState !== CLOSED) return
      // The browser gave up (e.g. a non-200 answer): the places shown would go stale — say so, try again slower each time.
      this.#entries = {}
      this.#streamError = 'Where everyone is working is not live right now (reconnecting).'
      console.error('[presence] presence feed closed; reconnecting')
      const wait = RETRY_MS[Math.min(this.#failures++, RETRY_MS.length - 1)]
      clearTimeout(this.#retry)
      this.#retry = setTimeout(() => this.#restart(), wait)
    })
    source.addEventListener('presence', (e) => {
      if (this.#source !== source || this.#stopped) return
      this.apply(JSON.parse((e as MessageEvent).data as string) as CompanyPresenceFrame)
    })
    source.addEventListener('presence-error', (e) => {
      if (this.#source !== source || this.#stopped) return
      const { error } = JSON.parse((e as MessageEvent).data as string) as { error?: string }
      this.#streamError = error ?? 'the presence feed failed'
      console.error('[presence] presence feed:', this.#streamError)
    })
  }

  #restart(): void {
    this.#source?.close()
    this.#source = null
    this.#start()
  }
}

const KEY = Symbol('company-presence')

/** The nucleus layout owns the feed (null while Messages, which owns presence, is off). */
export function setCompanyPresence(company: CompanyPresence | null): CompanyPresence | null {
  return setContext(KEY, company)
}

export function getCompanyPresence(): CompanyPresence | null {
  const company = getContext<CompanyPresence | null | undefined>(KEY)
  if (company === undefined)
    throw new Error('presence: no presence feed — getCompanyPresence() works only under the nucleus layout')
  return company
}
