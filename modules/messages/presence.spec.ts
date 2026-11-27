import type { CoworkerPresencePort, CoworkerPresenceStatus } from './presence'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { WhereReport } from '$lib/presence/where'
import { PresenceTracker } from '$lib/server/presence/tracker'
import {
  presenceFor,
  presenceStreamFor,
  reportPresence,
  setDoNotDisturb,
  setShareWhere,
  VIEWER_RECHECK_MS,
  WHERE_CACHE_MS,
  whereFilter,
  type PresenceFrame,
  type ShareWherePort,
  type WhereDrivePort,
} from './presence'
import { createChannel, MessagesError, openDm } from './service'
import { NO_COWORKERS } from './test-fixtures'
import { addCoworker, fixture } from './test-fixtures'

const HERE: WhereReport = { area: 'messages', path: '/messages', item: null }

/** Drive as each viewer may open it: names by id, and who may open what. */
function fakeDrive() {
  const names = new Map<string, string>([
    ['f1', 'Budget.xlsx'],
    ['d1', 'Plans'],
  ])
  const allowed = new Map<string, Set<string>>([
    ['f1', new Set(['owner', 'bea'])],
    ['d1', new Set(['owner'])],
  ])
  const calls: string[] = []
  const port: WhereDrivePort = {
    async itemName(viewerId, kind, id) {
      calls.push(`${viewerId}:${kind}:${id}`)
      return allowed.get(id)?.has(viewerId) ? (names.get(id) ?? null) : null
    },
  }
  return { port, allowed, calls }
}

function setup() {
  const f = fixture()
  const tracker = new PresenceTracker(() => new Date(Date.UTC(2026, 10, 12, 9, 0, 0)))
  tracker.setShareWhereOff([])
  const drive = fakeDrive()
  const stored = new Map<string, boolean>()
  const shareStore: ShareWherePort = { set: async (userId, on) => void stored.set(userId, on) }
  return { ...f, tracker, drive, stored, shareStore }
}

/** Lets the feed's ordered sends (where is filtered per viewer, asynchronously) go out. */
const settle = () => new Promise((r) => setTimeout(r, 0))

const CLIENT = 'tab-0123456789abcdef'

async function code(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (err) {
    if (err instanceof MessagesError) return err.code
    throw err
  }
  return 'ok'
}

afterEach(() => {
  vi.useRealTimers()
})

describe('reportPresence (the heartbeat)', () => {
  it('a member’s heartbeat makes them online / away', async () => {
    const { deps, tracker } = setup()
    await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active', where: HERE })
    expect(tracker.get('bea').status).toBe('online')
    await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'idle', where: HERE })
    expect(tracker.get('bea').status).toBe('away')
  })

  it('answers the reporter’s own presence (the shell shows it in the main nav, Contribute e4ef6be1)', async () => {
    const { deps, tracker } = setup()
    expect(await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active', where: HERE })).toMatchObject({ userId: 'bea', status: 'online', doNotDisturb: false })
    await setDoNotDisturb(deps, tracker, 'bea', { doNotDisturb: true })
    expect(await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'idle', where: HERE })).toMatchObject({ userId: 'bea', status: 'dnd', doNotDisturb: true })
  })

  it('validates the body', async () => {
    const { deps, tracker } = setup()
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'busy', where: HERE }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: 'x', state: 'active', where: HERE }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: 'has spaces in it!', state: 'active', where: HERE }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { state: 'active', where: HERE }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active' }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active', where: null }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active', where: { area: 'messages', path: '/messages?c=1', item: null } }))).toBe('invalid')
    expect(tracker.get('bea').status).toBe('offline')
  })

  it('carries where the tab is; a closing tab may say nowhere', async () => {
    const { deps, tracker } = setup()
    const file: WhereReport = { area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1' } }
    expect(await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active', where: file })).toMatchObject({ where: file, shareWhere: true })
    expect(await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'gone', where: null })).toMatchObject({ status: 'offline', where: null })
  })

  it('the reason for a wrong where is in the answer', async () => {
    const { deps, tracker } = setup()
    await expect(reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'idle', where: { area: 'drive', path: 'drive', item: null } })).rejects.toThrow(/pathname/)
  })

  it('nobody outside the company has a presence', async () => {
    const { deps, tracker } = setup()
    expect(await code(reportPresence(deps, tracker, 'stranger', { clientId: CLIENT, state: 'active', where: HERE }))).toBe('forbidden')
    expect(tracker.get('stranger').status).toBe('offline')
  })
})

describe('setDoNotDisturb', () => {
  it('sets the person’s own toggle and returns their presence', async () => {
    const { deps, tracker } = setup()
    await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active', where: HERE })
    expect(await setDoNotDisturb(deps, tracker, 'bea', { doNotDisturb: true })).toMatchObject({ userId: 'bea', status: 'dnd' })
    expect(await setDoNotDisturb(deps, tracker, 'bea', { doNotDisturb: false })).toMatchObject({ status: 'online' })
  })

  it('validates the body and refuses non-members', async () => {
    const { deps, tracker } = setup()
    expect(await code(setDoNotDisturb(deps, tracker, 'bea', { doNotDisturb: 'yes' }))).toBe('invalid')
    expect(await code(setDoNotDisturb(deps, tracker, 'stranger', { doNotDisturb: true }))).toBe('forbidden')
  })
})

describe('presenceStreamFor (what one viewer’s live feed carries)', () => {
  it('nothing for someone outside the company', async () => {
    const { deps, tracker, drive } = setup()
    expect(await presenceStreamFor(deps, async () => tracker, 'stranger', NO_COWORKERS, drive.port)).toBeNull()
  })

  it('a member gets everyone in the company (offline included), then each change', async () => {
    const { deps, tracker, drive } = setup()
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'idle', where: HERE })
    const stream = await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS, drive.port)
    const frames: PresenceFrame[] = []
    const stop = await stream!.start((f) => frames.push(f))
    expect(frames).toEqual([
      {
        replace: true,
        people: [
          { userId: 'owner', status: 'offline', doNotDisturb: false, lastSeenAt: null, where: null, shareWhere: true },
          { userId: 'bea', status: 'offline', doNotDisturb: false, lastSeenAt: null, where: null, shareWhere: true },
          {
            userId: 'carl',
            status: 'away',
            doNotDisturb: false,
            lastSeenAt: '2026-11-12T09:00:00.000Z',
            where: { area: 'messages', path: '/messages', item: null },
            shareWhere: true,
          },
        ],
      },
    ])
    await reportPresence(deps, tracker, 'owner', { clientId: CLIENT, state: 'active', where: HERE })
    await settle()
    expect(frames[1]).toEqual({ replace: false, people: [expect.objectContaining({ userId: 'owner', status: 'online' })] })
    stop()
    await reportPresence(deps, tracker, 'owner', { clientId: CLIENT, state: 'gone', where: null })
    await settle()
    expect(frames).toHaveLength(2)
  })

  it('stops when the viewer is no longer in the company', async () => {
    vi.useFakeTimers()
    const { deps, tracker, directory, drive } = setup()
    const frames: PresenceFrame[] = []
    await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS, drive.port))!.start((f) => frames.push(f))
    directory.roles.delete('bea')
    await vi.advanceTimersByTimeAsync(VIEWER_RECHECK_MS)
    await reportPresence(deps, tracker, 'owner', { clientId: CLIENT, state: 'active', where: HERE })
    await vi.advanceTimersByTimeAsync(0)
    expect(frames).toHaveLength(1)
  })
})

describe('AI co-workers in presence (Contribute 14aea69d): from facts, never "offline"', () => {
  function withCoworkers() {
    const f = setup()
    addCoworker(f, { id: 'ada', slug: 'ada', name: 'Ada' })
    addCoworker(f, { id: 'max', slug: 'max', name: 'Max' })
    const statuses = new Map<string, CoworkerPresenceStatus>([
      ['ada', 'available'],
      ['max', 'paused'],
    ])
    const listeners = new Set<() => void>()
    const port: CoworkerPresencePort = {
      statuses: async () => new Map(statuses),
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    }
    const change = async (id: string, s: CoworkerPresenceStatus) => {
      statuses.set(id, s)
      for (const fn of listeners) fn()
      await new Promise((r) => setTimeout(r, 0))
    }
    return { ...f, port, change, listeners }
  }

  it('an enabled co-worker is available, a switched-off one paused; then each change, once', async () => {
    const { deps, tracker, port, change, listeners, drive } = withCoworkers()
    const frames: PresenceFrame[] = []
    const stop = await (await presenceStreamFor(deps, async () => tracker, 'bea', port, drive.port))!.start((f) => frames.push(f))
    expect(frames[0].people.filter((p) => p.userId === 'ada' || p.userId === 'max')).toEqual([
      { userId: 'ada', status: 'available', doNotDisturb: false, lastSeenAt: null, where: null, shareWhere: false },
      { userId: 'max', status: 'paused', doNotDisturb: false, lastSeenAt: null, where: null, shareWhere: false },
    ])
    await change('ada', 'busy')
    expect(frames[1]).toEqual({ replace: false, people: [{ userId: 'ada', status: 'busy', doNotDisturb: false, lastSeenAt: null, where: null, shareWhere: false }] })
    await change('ada', 'busy')
    expect(frames).toHaveLength(2)
    stop()
    expect(listeners.size).toBe(0)
  })

  it('a co-worker without a status (removed) is paused, never offline', async () => {
    const { deps, tracker, drive } = withCoworkers()
    const frames: PresenceFrame[] = []
    await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS, drive.port))!.start((f) => frames.push(f))
    expect(frames[0].people.find((p) => p.userId === 'ada')?.status).toBe('paused')
  })
})

describe('setShareWhere ("Share where I am")', () => {
  it('stores the person’s switch, tells the tracker and answers their presence', async () => {
    const { deps, tracker, stored, shareStore } = setup()
    expect(await setShareWhere(deps, tracker, shareStore, 'bea', { shareWhere: false })).toMatchObject({ userId: 'bea', shareWhere: false })
    expect(stored.get('bea')).toBe(false)
    expect(tracker.get('bea').shareWhere).toBe(false)
    expect(await setShareWhere(deps, tracker, shareStore, 'bea', { shareWhere: true })).toMatchObject({ shareWhere: true })
  })

  it('validates the body and refuses non-members (nothing stored)', async () => {
    const { deps, tracker, stored, shareStore } = setup()
    expect(await code(setShareWhere(deps, tracker, shareStore, 'bea', { shareWhere: 'no' }))).toBe('invalid')
    expect(await code(setShareWhere(deps, tracker, shareStore, 'stranger', { shareWhere: false }))).toBe('forbidden')
    expect(stored.size).toBe(0)
  })
})

describe('whereFilter (what one viewer is shown of someone’s place — fails closed)', () => {
  const at = (where: WhereReport | null, shareWhere = true) => ({
    userId: 'carl',
    status: 'online' as const,
    doNotDisturb: false,
    lastSeenAt: null,
    where,
    shareWhere,
  })
  const file: WhereReport = { area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1' } }
  const folder: WhereReport = { area: 'drive', path: '/drive/folder/d1', item: { kind: 'drive_folder', id: 'd1' } }

  it('the area and path of a page with nothing open, to every member', async () => {
    const { deps, drive } = setup()
    expect(await whereFilter(deps, drive.port, 'bea')(at(HERE))).toEqual({ area: 'messages', path: '/messages', item: null })
  })

  it('a Drive item (with its name) only to who may open it; otherwise just the area', async () => {
    const { deps, drive } = setup()
    expect(await whereFilter(deps, drive.port, 'bea')(at(file))).toEqual({
      area: 'drive',
      path: '/drive/file/f1',
      item: { kind: 'drive_file', id: 'f1', title: 'Budget.xlsx' },
    })
    expect(await whereFilter(deps, drive.port, 'bea')(at(folder))).toEqual({ area: 'drive', path: null, item: null })
    expect(await whereFilter(deps, drive.port, 'owner')(at(folder))).toMatchObject({ item: { title: 'Plans' } })
  })

  it('a channel by name to who may read it; a DM only to its participants, titled for them', async () => {
    const { deps, drive } = setup()
    const general = await createChannel(deps, 'owner', { name: 'general', private: false })
    const secret = await createChannel(deps, 'owner', { name: 'leadership', private: true, userIds: ['carl'] })
    const dm = await openDm(deps, 'bea', ['carl'])
    const inChat = (id: string): WhereReport => ({ area: 'messages', path: `/messages/${id}`, item: { kind: 'conversation', id } })
    expect((await whereFilter(deps, drive.port, 'bea')(at(inChat(general.id))))?.item).toEqual({ kind: 'conversation', id: general.id, title: 'general' })
    expect(await whereFilter(deps, drive.port, 'bea')(at(inChat(secret.id)))).toEqual({ area: 'messages', path: null, item: null })
    expect((await whereFilter(deps, drive.port, 'bea')(at(inChat(dm.id))))?.item?.title).toBe('Carl Member')
    expect(await whereFilter(deps, drive.port, 'owner')(at(inChat(dm.id)))).toEqual({ area: 'messages', path: null, item: null })
    expect(await whereFilter(deps, drive.port, 'owner')(at(inChat('not-a-conversation')))).toEqual({ area: 'messages', path: null, item: null })
  })

  it('nowhere when they switched sharing off — but a person always sees their own place', async () => {
    const { deps, drive } = setup()
    expect(await whereFilter(deps, drive.port, 'bea')(at(file, false))).toBeNull()
    expect(await whereFilter(deps, drive.port, 'carl')(at(HERE, false))).toEqual({ area: 'messages', path: '/messages', item: null })
    expect(await whereFilter(deps, drive.port, 'bea')(at(null))).toBeNull()
  })

  it('a failing lookup hides the item (and says so in the log)', async () => {
    const { deps } = setup()
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    const broken: WhereDrivePort = {
      itemName: async () => {
        throw new Error('db down')
      },
    }
    expect(await whereFilter(deps, broken, 'bea')(at(file))).toEqual({ area: 'drive', path: null, item: null })
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })

  it('remembers each answer briefly, so a heartbeat costs no lookup per viewer', async () => {
    let now = 0
    const { deps, drive } = setup()
    const filter = whereFilter(deps, drive.port, 'bea', { now: () => now })
    await filter(at(file))
    await filter(at(file))
    expect(drive.calls).toEqual(['bea:drive_file:f1'])
    drive.allowed.get('f1')!.delete('bea')
    now += WHERE_CACHE_MS
    expect(await filter(at(file))).toEqual({ area: 'drive', path: null, item: null })
    expect(drive.calls).toHaveLength(2)
  })
})

describe('presenceStreamFor — where, filtered for the viewer', () => {
  const file: WhereReport = { area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1' } }
  const folder: WhereReport = { area: 'drive', path: '/drive/folder/d1', item: { kind: 'drive_folder', id: 'd1' } }

  it('the snapshot and each move show only what the viewer may open', async () => {
    const { deps, tracker, drive } = setup()
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'active', where: file })
    const frames: PresenceFrame[] = []
    const stop = await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS, drive.port))!.start((f) => frames.push(f))
    expect(frames[0].people.find((p) => p.userId === 'carl')?.where).toEqual({
      area: 'drive',
      path: '/drive/file/f1',
      item: { kind: 'drive_file', id: 'f1', title: 'Budget.xlsx' },
    })
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'active', where: folder })
    await settle()
    expect(frames[1].people).toEqual([expect.objectContaining({ userId: 'carl', where: { area: 'drive', path: null, item: null } })])
    stop()
  })

  it('a move the viewer cannot tell apart (hidden item to hidden item) is not news', async () => {
    const { deps, tracker, drive } = setup()
    drive.allowed.set('f1', new Set())
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'active', where: file })
    const frames: PresenceFrame[] = []
    await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS, drive.port))!.start((f) => frames.push(f))
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'active', where: folder })
    await settle()
    expect(frames).toHaveLength(1)
  })

  it('switching sharing off reaches the others as "nowhere", status kept', async () => {
    const { deps, tracker, drive, shareStore } = setup()
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'active', where: HERE })
    const frames: PresenceFrame[] = []
    await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS, drive.port))!.start((f) => frames.push(f))
    await setShareWhere(deps, tracker, shareStore, 'carl', { shareWhere: false })
    await settle()
    expect(frames[1].people).toEqual([expect.objectContaining({ userId: 'carl', status: 'online', where: null, shareWhere: false })])
  })

  it('losing access shows on the next re-check, without the person moving', async () => {
    vi.useFakeTimers()
    const { deps, tracker, drive } = setup()
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'active', where: file })
    const frames: PresenceFrame[] = []
    const stop = await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS, drive.port))!.start((f) => frames.push(f))
    drive.allowed.set('f1', new Set())
    await vi.advanceTimersByTimeAsync(Math.max(VIEWER_RECHECK_MS, WHERE_CACHE_MS))
    expect(frames.at(-1)?.people).toEqual([expect.objectContaining({ userId: 'carl', where: { area: 'drive', path: null, item: null } })])
    stop()
  })
})

describe('presenceFor (messages.presence: everyone’s status + where, as the caller may see it)', () => {
  it('everyone in the company, or one person', async () => {
    const f = setup()
    const { deps, tracker, drive } = f
    addCoworker(f, { id: 'ada', slug: 'ada', name: 'Ada' })
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'active', where: { area: 'drive', path: '/drive/folder/d1', item: { kind: 'drive_folder', id: 'd1' } } })
    const coworkers: CoworkerPresencePort = { statuses: async () => new Map([['ada', 'busy']]), subscribe: () => () => {} }
    const all = await presenceFor(deps, tracker, drive.port, coworkers, 'bea')
    expect(all.people.map((p) => `${p.userId}:${p.status}`)).toEqual(['owner:offline', 'bea:offline', 'carl:online', 'ada:busy'])
    expect(all.people.find((p) => p.userId === 'carl')?.where).toEqual({ area: 'drive', path: null, item: null })
    expect(all.people.find((p) => p.userId === 'ada')?.where).toBeNull()
    const one = await presenceFor(deps, tracker, drive.port, coworkers, 'owner', 'carl')
    expect(one.people).toEqual([expect.objectContaining({ userId: 'carl', where: expect.objectContaining({ item: expect.objectContaining({ title: 'Plans' }) }) })])
  })

  it('someone unknown is not found; a caller outside the company is refused', async () => {
    const { deps, tracker, drive } = setup()
    expect(await code(presenceFor(deps, tracker, drive.port, NO_COWORKERS, 'bea', 'nobody'))).toBe('not_found')
    expect(await code(presenceFor(deps, tracker, drive.port, NO_COWORKERS, 'stranger'))).toBe('forbidden')
  })
})
