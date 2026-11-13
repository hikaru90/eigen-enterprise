import { afterEach, describe, expect, it, vi } from 'vitest'
import { PresenceTracker } from '$lib/server/presence/tracker'
import { presenceStreamFor, reportPresence, setDoNotDisturb, VIEWER_RECHECK_MS, type PresenceFrame } from './presence'
import { MessagesError } from './service'
import { fixture } from './test-fixtures'

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
    expect(await presenceStreamFor(deps, async () => tracker, 'stranger')).toBeNull()
  })

  it('a member gets everyone in the company (offline included), then each change', async () => {
    const { deps, tracker } = setup()
    await reportPresence(deps, tracker, 'carl', { clientId: CLIENT, state: 'idle' })
    const stream = await presenceStreamFor(deps, async () => tracker, 'bea')
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
    await (await presenceStreamFor(deps, async () => tracker, 'bea'))!.start((f) => frames.push(f))
    directory.roles.delete('bea')
    await vi.advanceTimersByTimeAsync(VIEWER_RECHECK_MS)
    await reportPresence(deps, tracker, 'owner', { clientId: CLIENT, state: 'active' })
    expect(frames).toHaveLength(1)
  })
})
