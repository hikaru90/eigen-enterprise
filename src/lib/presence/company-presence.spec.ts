import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CompanyPresence,
  type CompanyPresenceEntry,
  type PresenceStreamSource,
} from './company-presence.svelte'

/** A stand-in EventSource the test drives by hand. */
class FakeSource implements PresenceStreamSource {
  readyState = 0
  closed = false
  #listeners = new Map<string, ((e: Event) => void)[]>()
  addEventListener(type: string, fn: (e: Event) => void) {
    this.#listeners.set(type, [...(this.#listeners.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  emit(type: string, data?: unknown) {
    const e = data === undefined ? new Event(type) : new MessageEvent(type, { data: JSON.stringify(data) })
    for (const fn of this.#listeners.get(type) ?? []) fn(e)
  }
  open() {
    this.readyState = 1
    this.emit('open')
  }
}

const entry = (over: Partial<CompanyPresenceEntry> & { userId: string }): CompanyPresenceEntry => ({
  status: 'online',
  doNotDisturb: false,
  lastSeenAt: '2026-11-27T09:00:00.000Z',
  shareWhere: true,
  where: { area: 'drive', path: '/drive', item: null },
  ...over,
})

const DIRECTORY = {
  people: [
    { id: 'me', name: 'Alex Owner', email: 'alex@k.test', image: null, kind: 'human' },
    { id: 'anna', name: 'Anna Müller', email: 'anna@k.test', image: '/api/profile/anna/picture', kind: 'human' },
    { id: 'ben', name: 'Ben Ode', email: 'ben@k.test', image: null, kind: 'human' },
    { id: 'cara', name: 'Cara Lin', email: 'cara@k.test', image: null, kind: 'human' },
    { id: 'nova', name: 'Nova', email: 'nova@k.test', image: null, kind: 'coworker' },
  ],
  groups: [],
}

const settle = () => new Promise((r) => setTimeout(r, 0))
const AREAS: Record<string, string> = { drive: 'Drive', messages: 'Messages', dashboard: 'Dashboard' }

function setup(fetchImpl?: (url: string) => Promise<Response>) {
  const sources: FakeSource[] = []
  const fetch = vi.fn(fetchImpl ?? (async () => Response.json(DIRECTORY)))
  const company = new CompanyPresence({
    me: 'me',
    open: () => {
      const s = new FakeSource()
      sources.push(s)
      return s
    },
    fetch,
    areaName: (id) => AREAS[id] ?? null,
  })
  return { company, sources, fetch }
}

describe('CompanyPresence (where everyone is working — the live presence feed)', () => {
  let err: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    err = vi.spyOn(console, 'error').mockImplementation(() => {})
  })
  afterEach(() => {
    err.mockRestore()
    vi.useRealTimers()
  })

  it('opens the stream and loads the people directory once', async () => {
    const { company, sources, fetch } = setup()
    company.connect()
    await settle()
    expect(sources).toHaveLength(1)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/api/messages/people')
    company.close()
    expect(sources[0].closed).toBe(true)
  })

  it('peopleIn(area): others in that area right now — not me, not offline, not co-workers', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].open()
    sources[0].emit('presence', {
      replace: true,
      people: [
        entry({ userId: 'me' }),
        entry({ userId: 'anna', where: { area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1', title: 'Q4 plan.xlsx' } } }),
        entry({ userId: 'ben', status: 'away' }),
        entry({ userId: 'cara', status: 'offline' }),
        entry({ userId: 'nova', status: 'available', where: null }),
      ],
    })
    expect(company.peopleIn('drive').map((p) => p.userId)).toEqual(['anna', 'ben'])
    expect(company.peopleIn('messages')).toEqual([])
    const [anna, ben] = company.peopleIn('drive')
    expect(anna).toMatchObject({ name: 'Anna Müller', image: '/api/profile/anna/picture', place: 'Q4 plan.xlsx', label: 'Anna Müller · Q4 plan.xlsx' })
    expect(ben).toMatchObject({ name: 'Ben Ode', place: 'Drive', label: 'Ben Ode · Drive' })
    expect(ben.presence.status).toBe('away')
  })

  it('someone who does not share where they are, or whose place is hidden, is in no area', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].emit('presence', {
      replace: true,
      people: [entry({ userId: 'anna', shareWhere: false, where: null }), entry({ userId: 'ben', where: { area: null, path: null, item: null } })],
    })
    expect(company.peopleIn('drive')).toEqual([])
    expect(company.others).toEqual([])
  })

  it('a change merges; a snapshot (every reconnect) replaces', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].emit('presence', { replace: true, people: [entry({ userId: 'anna' }), entry({ userId: 'ben' })] })
    sources[0].emit('presence', { replace: false, people: [entry({ userId: 'anna', where: { area: 'messages', path: '/messages', item: null } })] })
    expect(company.peopleIn('drive').map((p) => p.userId)).toEqual(['ben'])
    expect(company.peopleIn('messages').map((p) => p.userId)).toEqual(['anna'])
    sources[0].emit('presence', { replace: true, people: [entry({ userId: 'cara' })] })
    expect(company.peopleIn('drive').map((p) => p.userId)).toEqual(['cara'])
    expect(company.peopleIn('messages')).toEqual([])
  })

  it('hereWithMe: the same item; with no item on either side, the same page', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].emit('presence', {
      replace: true,
      people: [
        entry({ userId: 'anna', where: { area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1', title: 'Q4 plan.xlsx' } } }),
        entry({ userId: 'ben', where: { area: 'drive', path: '/drive', item: null } }),
        entry({ userId: 'cara', where: { area: 'drive', path: null, item: null } }),
      ],
    })
    expect(company.hereWithMe({ area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1' } }).map((p) => p.userId)).toEqual(['anna'])
    expect(company.hereWithMe({ area: 'drive', path: '/drive', item: null }).map((p) => p.userId)).toEqual(['ben'])
    expect(company.hereWithMe({ area: 'drive', path: '/drive/file/f2', item: { kind: 'drive_file', id: 'f2' } })).toEqual([])
    expect(company.hereWithMe(null)).toEqual([])
  })

  it('a label with no known place is the name alone', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].emit('presence', { replace: true, people: [entry({ userId: 'anna', where: { area: 'website', path: '/m/website', item: null } })] })
    expect(company.peopleIn('website')[0]).toMatchObject({ place: null, label: 'Anna Müller' })
  })

  it('someone the directory does not know yet reloads it once, then shows them', async () => {
    let people = DIRECTORY.people.filter((p) => p.id !== 'ben')
    const { company, sources, fetch } = setup(async () => Response.json({ people, groups: [] }))
    company.connect()
    await settle()
    people = DIRECTORY.people
    sources[0].emit('presence', { replace: true, people: [entry({ userId: 'ben' })] })
    expect(company.peopleIn('drive')).toEqual([])
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(company.peopleIn('drive').map((p) => p.name)).toEqual(['Ben Ode'])
    sources[0].emit('presence', { replace: false, people: [entry({ userId: 'ben', status: 'away' })] })
    await settle()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('a directory that cannot load is shown, never swallowed', async () => {
    const { company } = setup(async () => Response.json({ error: 'messages store down' }, { status: 500 }))
    company.connect()
    await settle()
    expect(company.error).toBe('The people list could not be loaded: messages store down')
  })

  it('the server’s presence-error frame is shown until the next good frame', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].emit('presence-error', { error: 'tracker down' })
    expect(company.error).toBe('tracker down')
    sources[0].emit('presence', { replace: true, people: [] })
    expect(company.error).toBeNull()
  })

  it('a stream the browser gave up on says so, forgets the stale places and reconnects', async () => {
    vi.useFakeTimers()
    const { company, sources } = setup()
    company.connect()
    await vi.advanceTimersByTimeAsync(0)
    sources[0].open()
    sources[0].emit('presence', { replace: true, people: [entry({ userId: 'anna' })] })
    expect(company.status).toBe('live')
    sources[0].readyState = 2
    sources[0].emit('error')
    expect(company.status).toBe('reconnecting')
    expect(company.error).toBe('Where everyone is working is not live right now (reconnecting).')
    expect(company.peopleIn('drive')).toEqual([])
    await vi.advanceTimersByTimeAsync(5_000)
    expect(sources).toHaveLength(2)
    sources[1].open()
    expect(company.status).toBe('live')
    expect(company.error).toBeNull()
  })

  it('a dropped connection the browser retries by itself keeps the places', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].open()
    sources[0].emit('presence', { replace: true, people: [entry({ userId: 'anna' })] })
    sources[0].readyState = 0
    sources[0].emit('error')
    expect(company.status).toBe('reconnecting')
    expect(company.error).toBeNull()
    expect(company.peopleIn('drive')).toHaveLength(1)
  })

  it('resume() reopens a stream the browser closed; a live one is left alone', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    sources[0].open()
    company.resume()
    expect(sources).toHaveLength(1)
    sources[0].readyState = 2
    company.resume()
    expect(sources).toHaveLength(2)
  })

  it('after close() nothing more arrives', async () => {
    const { company, sources } = setup()
    company.connect()
    await settle()
    company.close()
    sources[0].emit('presence', { replace: true, people: [entry({ userId: 'anna' })] })
    expect(company.peopleIn('drive')).toEqual([])
  })
})
