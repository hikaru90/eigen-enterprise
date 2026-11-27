import { describe, expect, it, vi } from 'vitest'
import type { WhereReport } from '$lib/presence/where'
import { MAX_CLIENTS_PER_PERSON, OFFLINE_AFTER_MS, PresenceTracker, type Presence } from './tracker'

function setup() {
  let t = Date.UTC(2026, 10, 12, 9, 0, 0)
  const clock = { tick: (ms: number) => (t += ms), now: () => new Date(t), iso: () => new Date(t).toISOString() }
  const tracker = new PresenceTracker(clock.now)
  tracker.setShareWhereOff([])
  const changes: Presence[][] = []
  const unsubscribe = tracker.subscribe((changed) => changes.push(changed))
  return { tracker, clock, changes, unsubscribe }
}

const statuses = (changes: Presence[][]) => changes.map((c) => c.map((p) => `${p.userId}:${p.status}`))

describe('PresenceTracker', () => {
  it('someone it never heard from is offline, with no last-seen time', () => {
    const { tracker } = setup()
    expect(tracker.get('ann')).toEqual({ userId: 'ann', status: 'offline', doNotDisturb: false, lastSeenAt: null, where: null, shareWhere: true })
  })

  it('an active heartbeat is online, an idle one away; last seen is the latest heartbeat', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', null)
    expect(tracker.get('ann')).toMatchObject({ status: 'online', lastSeenAt: clock.iso() })
    clock.tick(25_000)
    tracker.heartbeat('ann', 'tab-1', 'idle', null)
    expect(tracker.get('ann')).toMatchObject({ status: 'away', lastSeenAt: clock.iso() })
  })

  it('several tabs/devices: online while any is active, away when all are idle', () => {
    const { tracker } = setup()
    tracker.heartbeat('ann', 'phone', 'idle', null)
    tracker.heartbeat('ann', 'desktop', 'active', null)
    expect(tracker.get('ann').status).toBe('online')
    tracker.heartbeat('ann', 'desktop', 'gone', null)
    expect(tracker.get('ann').status).toBe('away')
  })

  it('no heartbeat within the window is offline, and keeps when they were last seen', () => {
    const { tracker, clock, changes } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', null)
    const seen = clock.iso()
    clock.tick(OFFLINE_AFTER_MS - 1)
    tracker.sweep()
    expect(tracker.get('ann').status).toBe('online')
    clock.tick(1)
    tracker.sweep()
    expect(tracker.get('ann')).toEqual({ userId: 'ann', status: 'offline', doNotDisturb: false, lastSeenAt: seen, where: null, shareWhere: true })
    expect(statuses(changes)).toEqual([['ann:online'], ['ann:offline']])
  })

  it('the last tab closing ("gone") is offline at once', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', null)
    clock.tick(5_000)
    tracker.heartbeat('ann', 'tab-1', 'gone', null)
    expect(tracker.get('ann')).toMatchObject({ status: 'offline', lastSeenAt: clock.iso() })
  })

  it('do not disturb shows while connected, survives going offline, and shows again on return', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', null)
    expect(tracker.setDoNotDisturb('ann', true)).toMatchObject({ status: 'dnd', doNotDisturb: true })
    tracker.heartbeat('ann', 'tab-1', 'idle', null)
    expect(tracker.get('ann').status).toBe('dnd')
    clock.tick(OFFLINE_AFTER_MS)
    expect(tracker.get('ann')).toMatchObject({ status: 'offline', doNotDisturb: true })
    tracker.heartbeat('ann', 'tab-2', 'active', null)
    expect(tracker.get('ann').status).toBe('dnd')
    expect(tracker.setDoNotDisturb('ann', false).status).toBe('online')
  })

  it('in a call wins over everything — also without a heartbeat (they may be on the call page)', () => {
    const { tracker, changes } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', null)
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
    tracker.heartbeat('ann', 'tab-1', 'active', null)
    tracker.heartbeat('ann', 'tab-1', 'active', null)
    tracker.heartbeat('ann', 'tab-2', 'idle', null)
    tracker.setInCall([])
    tracker.sweep()
    expect(statuses(changes)).toEqual([['ann:online']])
    unsubscribe()
    tracker.heartbeat('ann', 'tab-1', 'gone', null)
    tracker.heartbeat('ann', 'tab-2', 'gone', null)
    expect(changes).toHaveLength(1)
  })

  it('a listener that throws does not stop the others', () => {
    const { tracker, changes } = setup()
    tracker.subscribe(() => {
      throw new Error('boom')
    })
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    tracker.heartbeat('ann', 'tab-1', 'active', null)
    expect(changes).toHaveLength(1)
    expect(logged).toHaveBeenCalledTimes(1)
    logged.mockRestore()
  })

  it('lists people in the order asked, unknown ones offline', () => {
    const { tracker } = setup()
    tracker.heartbeat('ben', 'tab-1', 'idle', null)
    expect(tracker.list(['ann', 'ben']).map((p) => `${p.userId}:${p.status}`)).toEqual(['ann:offline', 'ben:away'])
  })

  it('keeps at most a handful of clients per person (the oldest heartbeat goes first)', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'first', 'active', null)
    for (let i = 0; i < MAX_CLIENTS_PER_PERSON; i++) {
      clock.tick(1)
      tracker.heartbeat('ann', `idle-${i}`, 'idle', null)
    }
    // "first" (the only active one) was dropped to make room.
    expect(tracker.get('ann').status).toBe('away')
  })
})

const drive: WhereReport = { area: 'drive', path: '/drive', item: null }
const file: WhereReport = { area: 'drive', path: '/drive/file/f1', item: { kind: 'drive_file', id: 'f1' } }
const chat: WhereReport = { area: 'messages', path: '/messages', item: { kind: 'conversation', id: 'c1' } }
const wheres = (changes: Presence[][]) => changes.map((c) => c.map((p) => `${p.userId}:${p.where?.path ?? '-'}`))

describe('PresenceTracker — where someone is working (plan/phase-multiplayer-presence.md)', () => {
  it('a person is where their tab says; nowhere while offline', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', file)
    expect(tracker.get('ann')).toMatchObject({ status: 'online', where: file })
    clock.tick(OFFLINE_AFTER_MS)
    expect(tracker.get('ann').where).toBeNull()
  })

  it('several tabs: the most recently active tab wins, else the most recent one', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'desk', 'active', file)
    clock.tick(1)
    tracker.heartbeat('ann', 'phone', 'idle', chat)
    expect(tracker.get('ann').where).toEqual(file)
    clock.tick(1)
    tracker.heartbeat('ann', 'desk', 'idle', file)
    // No tab is active now: the latest heartbeat's tab.
    expect(tracker.get('ann').where).toEqual(file)
    clock.tick(1)
    tracker.heartbeat('ann', 'phone', 'idle', chat)
    expect(tracker.get('ann').where).toEqual(chat)
    clock.tick(1)
    tracker.heartbeat('ann', 'desk', 'active', drive)
    tracker.heartbeat('ann', 'phone', 'idle', chat)
    expect(tracker.get('ann').where).toEqual(drive)
    tracker.heartbeat('ann', 'desk', 'gone', null)
    expect(tracker.get('ann').where).toEqual(chat)
  })

  it('a tab without a place (null) does not hide another tab’s', () => {
    const { tracker, clock } = setup()
    tracker.heartbeat('ann', 'desk', 'active', file)
    clock.tick(1)
    tracker.heartbeat('ann', 'phone', 'active', null)
    expect(tracker.get('ann').where).toEqual(file)
  })

  it('moving is news: subscribers hear each new place, not a repeated one', () => {
    const { tracker, changes } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', drive)
    tracker.heartbeat('ann', 'tab-1', 'active', { ...drive })
    tracker.heartbeat('ann', 'tab-1', 'active', file)
    tracker.heartbeat('ann', 'tab-1', 'gone', null)
    expect(wheres(changes)).toEqual([['ann:/drive'], ['ann:/drive/file/f1'], ['ann:-']])
  })

  it('the share switch: on by default, set by the person, announced', () => {
    const { tracker, changes } = setup()
    tracker.heartbeat('ann', 'tab-1', 'active', drive)
    expect(tracker.get('ann').shareWhere).toBe(true)
    expect(tracker.setShareWhere('ann', false)).toMatchObject({ shareWhere: false, where: drive })
    expect(tracker.get('ann').shareWhere).toBe(false)
    expect(changes.at(-1)).toEqual([expect.objectContaining({ userId: 'ann', shareWhere: false })])
    tracker.setShareWhere('ann', true)
    expect(changes).toHaveLength(3)
  })

  it('the stored switches replace what it knew; someone who switched it off stays off while offline', () => {
    const { tracker, changes } = setup()
    tracker.setShareWhereOff(['ben'])
    expect(tracker.get('ben')).toMatchObject({ status: 'offline', shareWhere: false })
    expect(changes).toEqual([[expect.objectContaining({ userId: 'ben', shareWhere: false })]])
    tracker.setShareWhereOff([])
    expect(tracker.get('ben').shareWhere).toBe(true)
    tracker.sweep()
    expect(changes).toHaveLength(2)
  })

  it('until the stored switches are known, nobody shares where they are (fails closed)', () => {
    const tracker = new PresenceTracker(() => new Date())
    tracker.heartbeat('ann', 'tab-1', 'active', drive)
    expect(tracker.get('ann')).toMatchObject({ shareWhere: false, where: drive })
    tracker.setShareWhereOff([])
    expect(tracker.get('ann').shareWhere).toBe(true)
  })

  it('a switch set before the store was first read is the person’s own; everyone else stays closed', () => {
    const tracker = new PresenceTracker(() => new Date())
    tracker.setShareWhere('ann', true)
    expect(tracker.get('ann').shareWhere).toBe(true)
    expect(tracker.get('ben').shareWhere).toBe(false)
  })

  it('a store read that began before a switch does not undo it; a later read wins', () => {
    const { tracker } = setup()
    const readAt = tracker.shareWhereRevision
    tracker.setShareWhere('ann', false)
    tracker.setShareWhereOff([], readAt) // the read started before Ann switched off
    expect(tracker.get('ann').shareWhere).toBe(false)
    tracker.setShareWhereOff([]) // a read after it (someone switched it on in the other process)
    expect(tracker.get('ann').shareWhere).toBe(true)
  })
})
