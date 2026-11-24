import { NO_COWORKERS } from './test-fixtures'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresenceTracker } from '$lib/server/presence/tracker'
import { presenceStreamFor, reportPresence, setDoNotDisturb, VIEWER_RECHECK_MS, type PresenceFrame } from './presence'
import { MessagesError } from './service'
import { addCoworker, fixture } from './test-fixtures'
import type { CoworkerPresencePort, CoworkerPresenceStatus } from './presence'

function setup() {
  const f = fixture()
  const tracker = new PresenceTracker(() => new Date(Date.UTC(2026, 10, 12, 9, 0, 0)))
  return { ...f, tracker }
}

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
    await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active' })
    expect(tracker.get('bea').status).toBe('online')
    await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'idle' })
    expect(tracker.get('bea').status).toBe('away')
  })

  it('answers the reporter’s own presence (the shell shows it in the main nav, Contribute e4ef6be1)', async () => {
    const { deps, tracker } = setup()
    expect(await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active' })).toMatchObject({ userId: 'bea', status: 'online', doNotDisturb: false })
    await setDoNotDisturb(deps, tracker, 'bea', { doNotDisturb: true })
    expect(await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'idle' })).toMatchObject({ userId: 'bea', status: 'dnd', doNotDisturb: true })
  })

  it('validates the body', async () => {
    const { deps, tracker } = setup()
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'busy' }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: 'x', state: 'active' }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { clientId: 'has spaces in it!', state: 'active' }))).toBe('invalid')
    expect(await code(reportPresence(deps, tracker, 'bea', { state: 'active' }))).toBe('invalid')
    expect(tracker.get('bea').status).toBe('offline')
  })

  it('nobody outside the company has a presence', async () => {
    const { deps, tracker } = setup()
    expect(await code(reportPresence(deps, tracker, 'stranger', { clientId: CLIENT, state: 'active' }))).toBe('forbidden')
    expect(tracker.get('stranger').status).toBe('offline')
  })
})

describe('setDoNotDisturb', () => {
  it('sets the person’s own toggle and returns their presence', async () => {
    const { deps, tracker } = setup()
    await reportPresence(deps, tracker, 'bea', { clientId: CLIENT, state: 'active' })
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
    const { deps, tracker } = setup()
    expect(await presenceStreamFor(deps, async () => tracker, 'stranger', NO_COWORKERS)).toBeNull()
  })

  it('a member gets everyone in the company (offline included), then each change', async () => {
    const { deps, tracker } = setup()
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'idle' })
    const stream = await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS)
    const frames: PresenceFrame[] = []
    const stop = await stream!.start((f) => frames.push(f))
    expect(frames).toEqual([
      {
        replace: true,
        people: [
          { userId: 'owner', status: 'offline', doNotDisturb: false, lastSeenAt: null },
          { userId: 'bea', status: 'offline', doNotDisturb: false, lastSeenAt: null },
          { userId: 'carl', status: 'away', doNotDisturb: false, lastSeenAt: '2026-11-12T09:00:00.000Z' },
        ],
      },
    ])
    await reportPresence(deps, tracker, 'owner', { clientId: CLIENT, state: 'active' })
    expect(frames[1]).toEqual({ replace: false, people: [expect.objectContaining({ userId: 'owner', status: 'online' })] })
    stop()
    await reportPresence(deps, tracker, 'owner', { clientId: CLIENT, state: 'gone' })
    expect(frames).toHaveLength(2)
  })

  it('stops when the viewer is no longer in the company', async () => {
    vi.useFakeTimers()
    const { deps, tracker, directory } = setup()
    const frames: PresenceFrame[] = []
    await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS))!.start((f) => frames.push(f))
    directory.roles.delete('bea')
    await vi.advanceTimersByTimeAsync(VIEWER_RECHECK_MS)
    await reportPresence(deps, tracker, 'owner', { clientId: CLIENT, state: 'active' })
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
    const { deps, tracker, port, change, listeners } = withCoworkers()
    const frames: PresenceFrame[] = []
    const stop = await (await presenceStreamFor(deps, async () => tracker, 'bea', port))!.start((f) => frames.push(f))
    expect(frames[0].people.filter((p) => p.userId === 'ada' || p.userId === 'max')).toEqual([
      { userId: 'ada', status: 'available', doNotDisturb: false, lastSeenAt: null },
      { userId: 'max', status: 'paused', doNotDisturb: false, lastSeenAt: null },
    ])
    await change('ada', 'busy')
    expect(frames[1]).toEqual({ replace: false, people: [{ userId: 'ada', status: 'busy', doNotDisturb: false, lastSeenAt: null }] })
    await change('ada', 'busy')
    expect(frames).toHaveLength(2)
    stop()
    expect(listeners.size).toBe(0)
  })

  it('a co-worker without a status (removed) is paused, never offline', async () => {
    const { deps, tracker } = withCoworkers()
    const frames: PresenceFrame[] = []
    await (await presenceStreamFor(deps, async () => tracker, 'bea', NO_COWORKERS))!.start((f) => frames.push(f))
    expect(frames[0].people.find((p) => p.userId === 'ada')?.status).toBe('paused')
  })
})
