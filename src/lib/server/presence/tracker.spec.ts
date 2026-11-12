import { describe, expect, it, vi } from 'vitest'
import { MAX_CLIENTS_PER_PERSON, OFFLINE_AFTER_MS, PresenceTracker, type Presence } from './tracker'

function setup() {
  let t = Date.UTC(2026, 10, 12, 9, 0, 0)
  const clock = { tick: (ms: number) => (t += ms), now: () => new Date(t), iso: () => new Date(t).toISOString() }
  const tracker = new PresenceTracker(clock.now)
  const changes: Presence[][] = []
  const unsubscribe = tracker.subscribe((changed) => changes.push(changed))
  return { tracker, clock, changes, unsubscribe }
}

const statuses = (changes: Presence[][]) => changes.map((c) => c.map((p) => `${p.userId}:${p.status}`))

describe('PresenceTracker', () => {
  it('someone it never heard from is offline, with no last-seen time', () => {
    const { tracker } = setup()
    expect(tracker.get('ann')).toEqual({ userId: 'ann', status: 'offline', doNotDisturb: false, lastSeenAt: null })
  })

  it('an active heartbeat is online, an idle one away; last seen is the latest heartbeat', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active')
    expect(tracker.get('ann')).toMatchObject({ status: 'online', lastSeenAt: clock.iso() })
    clock.tick(25_000)
    tracker.heartbeat('ann', 'tab-1', 'idle')
    expect(tracker.get('ann')).toMatchObject({ status: 'away', lastSeenAt: clock.iso() })
  })

  it('several tabs/devices: online while any is active, away when all are idle', () => {
    const { tracker } = setup()
    tracker.heartbeat('ann', 'phone', 'idle')
    tracker.heartbeat('ann', 'desktop', 'active')
    expect(tracker.get('ann').status).toBe('online')
    tracker.heartbeat('ann', 'desktop', 'gone')
    expect(tracker.get('ann').status).toBe('away')
  })

  it('no heartbeat within the window is offline, and keeps when they were last seen', () => {
    const { tracker, clock, changes } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active')
    const seen = clock.iso()
    clock.tick(OFFLINE_AFTER_MS - 1)
    tracker.sweep()
    expect(tracker.get('ann').status).toBe('online')
    clock.tick(1)
    tracker.sweep()
    expect(tracker.get('ann')).toEqual({ userId: 'ann', status: 'offline', doNotDisturb: false, lastSeenAt: seen })
    expect(statuses(changes)).toEqual([['ann:online'], ['ann:offline']])
  })

  it('the last tab closing ("gone") is offline at once', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active')
    clock.tick(5_000)
    tracker.heartbeat('ann', 'tab-1', 'gone')
    expect(tracker.get('ann')).toMatchObject({ status: 'offline', lastSeenAt: clock.iso() })
  })

  it('do not disturb shows while connected, survives going offline, and shows again on return', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active')
    expect(tracker.setDoNotDisturb('ann', true)).toMatchObject({ status: 'dnd', doNotDisturb: true })
    tracker.heartbeat('ann', 'tab-1', 'idle')
    expect(tracker.get('ann').status).toBe('dnd')
    clock.tick(OFFLINE_AFTER_MS)
    expect(tracker.get('ann')).toMatchObject({ status: 'offline', doNotDisturb: true })
    tracker.heartbeat('ann', 'tab-2', 'active')
    expect(tracker.get('ann').status).toBe('dnd')
    expect(tracker.setDoNotDisturb('ann', false).status).toBe('online')
  })

  it('in a call wins over everything — also without a heartbeat (they may be on the call page)', () => {
    const { tracker, changes } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active')
    tracker.setDoNotDisturb('ann', true)
    tracker.setInCall(['ann', 'ben'])
    expect(tracker.get('ann').status).toBe('in_call')
    expect(tracker.get('ben')).toMatchObject({ status: 'in_call', lastSeenAt: null })
    tracker.setInCall([])
    expect(tracker.get('ann').status).toBe('dnd')
    expect(tracker.get('ben').status).toBe('offline')
    expect(statuses(changes)).toEqual([
      ['ann:online'],
      ['ann:dnd'],
      ['ann:in_call', 'ben:in_call'],
      ['ann:dnd', 'ben:offline'],
    ])
  })

  it('tells subscribers about changes only — a repeated heartbeat is not news', () => {
    const { tracker, changes, unsubscribe } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active')
    tracker.heartbeat('ann', 'tab-1', 'active')
    tracker.heartbeat('ann', 'tab-2', 'idle')
    tracker.setInCall([])
    tracker.sweep()
    expect(statuses(changes)).toEqual([['ann:online']])
    unsubscribe()
    tracker.heartbeat('ann', 'tab-1', 'gone')
    tracker.heartbeat('ann', 'tab-2', 'gone')
    expect(changes).toHaveLength(1)
  })

  it('a listener that throws does not stop the others', () => {
    const { tracker, changes } = setup()
    tracker.subscribe(() => {
      throw new Error('boom')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    tracker.heartbeat('ann', 'tab-1', 'active')
    expect(changes).toHaveLength(1)
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })

  it('lists people in the order asked, unknown ones offline', () => {
    const { tracker } = setup()
    tracker.heartbeat('ben', 'tab-1', 'idle')
    expect(tracker.list(['ann', 'ben']).map((p) => `${p.userId}:${p.status}`)).toEqual(['ann:offline', 'ben:away'])
  })

  it('keeps at most a handful of clients per person (the oldest heartbeat goes first)', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'first', 'active')
    for (let i = 0; i < MAX_CLIENTS_PER_PERSON; i++) {
      clock.tick(1)
      tracker.heartbeat('ann', `idle-${i}`, 'idle')
    }
    // "first" (the only active one) was dropped to make room.
    expect(tracker.get('ann').status).toBe('away')
  })
})
