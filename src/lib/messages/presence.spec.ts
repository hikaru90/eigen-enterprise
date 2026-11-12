import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  applyPresence,
  HEARTBEAT_MS,
  IDLE_AFTER_MS,
  presenceLabel,
  presenceOf,
  PresenceHeartbeat,
  type HeartbeatState,
  type PresenceView,
} from './presence'

const NOW = new Date('2026-11-12T12:00:00.000Z')
const view = (over: Partial<PresenceView> = {}): PresenceView => ({
  userId: 'bea',
  status: 'online',
  doNotDisturb: false,
  lastSeenAt: null,
  ...over,
})
const ago = (ms: number) => new Date(NOW.getTime() - ms).toISOString()

describe('presenceLabel (what the dot’s tooltip and the header say)', () => {
  it('names every status in words', () => {
    expect(presenceLabel(view({ status: 'online' }), NOW)).toBe('Online')
    expect(presenceLabel(view({ status: 'away' }), NOW)).toBe('Away')
    expect(presenceLabel(view({ status: 'dnd', doNotDisturb: true }), NOW)).toBe('Do not disturb')
    expect(presenceLabel(view({ status: 'in_call' }), NOW)).toBe('In a call')
  })

  it('offline says when they were last active, if known', () => {
    expect(presenceLabel(view({ status: 'offline' }), NOW)).toBe('Offline')
    expect(presenceLabel(view({ status: 'offline', lastSeenAt: ago(20_000) }), NOW)).toBe('Active just now')
    expect(presenceLabel(view({ status: 'offline', lastSeenAt: ago(5 * 60_000) }), NOW)).toBe('Active 5 min ago')
    expect(presenceLabel(view({ status: 'offline', lastSeenAt: ago(2 * 3_600_000 + 60_000) }), NOW)).toBe('Active 2 h ago')
    expect(presenceLabel(view({ status: 'offline', lastSeenAt: ago(26 * 3_600_000) }), NOW)).toBe('Active yesterday')
    expect(presenceLabel(view({ status: 'offline', lastSeenAt: ago(3 * 86_400_000) }), NOW)).toBe('Active 3 days ago')
  })
})

describe('applyPresence / presenceOf', () => {
  it('a snapshot replaces, a change merges; someone unknown is offline', () => {
    let map = applyPresence({}, { replace: true, people: [view({ userId: 'bea' }), view({ userId: 'carl', status: 'away' })] })
    map = applyPresence(map, { replace: false, people: [view({ userId: 'carl', status: 'online' })] })
    expect(presenceOf(map, 'bea').status).toBe('online')
    expect(presenceOf(map, 'carl').status).toBe('online')
    map = applyPresence(map, { replace: true, people: [view({ userId: 'carl', status: 'offline' })] })
    expect(presenceOf(map, 'bea')).toEqual({ userId: 'bea', status: 'offline', doNotDisturb: false, lastSeenAt: null })
  })
})

class FakeDoc extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible'
}

describe('PresenceHeartbeat (one tab’s heartbeat)', () => {
  let doc: FakeDoc
  let win: EventTarget
  let sent: HeartbeatState[]
  let beat: PresenceHeartbeat

  beforeEach(() => {
    vi.useFakeTimers()
    doc = new FakeDoc()
    win = new EventTarget()
    sent = []
    beat = new PresenceHeartbeat({
      clientId: 'tab-0123456789',
      post: (body) => {
        expect(body.clientId).toBe('tab-0123456789')
        sent.push(body.state)
      },
      doc,
      win,
      now: () => Date.now(),
    })
  })
  afterEach(() => {
    beat.stop()
    vi.useRealTimers()
  })

  it('says active at once, then beats on an interval', () => {
    beat.start()
    expect(sent).toEqual(['active'])
    vi.advanceTimersByTime(HEARTBEAT_MS * 2)
    expect(sent).toEqual(['active', 'active', 'active'])
  })

  it('hidden tab → idle immediately; visible again → active immediately', () => {
    beat.start()
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(sent.at(-1)).toBe('idle')
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(sent.at(-1)).toBe('active')
  })

  it('no input for a few minutes → idle at the next beat; any input → active right away', () => {
    beat.start()
    vi.advanceTimersByTime(IDLE_AFTER_MS + HEARTBEAT_MS)
    expect(sent.at(-1)).toBe('idle')
    const before = sent.length
    win.dispatchEvent(new Event('pointermove'))
    expect(sent.length).toBe(before + 1)
    expect(sent.at(-1)).toBe('active')
    // Further input while active is not a request each time.
    win.dispatchEvent(new Event('keydown'))
    expect(sent.length).toBe(before + 1)
  })

  it('closing the tab says gone; stop() just stops (leaving Messages, still in the app)', () => {
    beat.start()
    win.dispatchEvent(new Event('pagehide'))
    expect(sent.at(-1)).toBe('gone')
    win.dispatchEvent(new Event('pageshow'))
    expect(sent.at(-1)).toBe('active')
    beat.stop()
    const count = sent.length
    vi.advanceTimersByTime(HEARTBEAT_MS * 3)
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(sent.length).toBe(count)
  })
})
