import type { CallDto } from './client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LiveCalls, type CallStreamSource } from './live-calls.svelte'

const T0 = Date.UTC(2026, 10, 11, 9, 0, 0)
const iso = (ms: number) => new Date(T0 + ms).toISOString()

const call = (over: Partial<CallDto> = {}): CallDto => ({
  id: 'c1',
  contextKind: 'dm',
  contextId: 'dm1',
  title: 'Ann Example, Ben Example',
  startedBy: 'ann',
  startedByName: 'Ann Example',
  state: 'ringing',
  startedAt: iso(0),
  answeredAt: null,
  endedAt: null,
  ringUntil: iso(45_000),
  participants: [],
  ...over,
})

/** An EventSource stand-in the spec drives by hand. */
class FakeSource implements CallStreamSource {
  readyState = 0
  closed = false
  private readonly listeners = new Map<string, Array<(e: Event) => void>>()
  addEventListener(type: string, fn: (e: Event) => void) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn])
  }
  close() {
    this.closed = true
    this.readyState = 2
  }
  open() {
    this.readyState = 1
    for (const fn of this.listeners.get('open') ?? []) fn(new Event('open'))
  }
  frame(type: 'call.ringing' | 'call.state', c: CallDto) {
    for (const fn of this.listeners.get(type) ?? []) fn(new MessageEvent(type, { data: JSON.stringify({ call: c }) }))
  }
  fail(closed: boolean) {
    if (closed) this.readyState = 2
    for (const fn of this.listeners.get('error') ?? []) fn(new Event('error'))
  }
  serverError(message: string) {
    for (const fn of this.listeners.get('error') ?? []) fn(new MessageEvent('error', { data: JSON.stringify({ error: message }) }))
  }
}

describe('LiveCalls (the one call feed of a nucleus page)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(T0)
  })
  afterEach(() => vi.useRealTimers())

  const connected = () => {
    const sources: FakeSource[] = []
    const live = new LiveCalls()
    live.connect(() => {
      const s = new FakeSource()
      sources.push(s)
      return s
    })
    sources[0].open()
    return { live, sources }
  }

  it('a ringing frame rings; a state frame for the same call stops the ringing but keeps it live', () => {
    const { live, sources } = connected()
    sources[0].frame('call.ringing', call())
    expect(live.ringing.map((c) => c.id)).toEqual(['c1'])
    expect(live.liveFor('dm', 'dm1')?.id).toBe('c1')
    sources[0].frame('call.state', call({ state: 'active' }))
    expect(live.ringing).toEqual([])
    expect(live.liveFor('dm', 'dm1')?.state).toBe('active')
  })

  it('a call that is over leaves the feed', () => {
    const { live, sources } = connected()
    sources[0].frame('call.ringing', call())
    sources[0].frame('call.state', call({ state: 'missed', endedAt: iso(45_000) }))
    expect(live.ringing).toEqual([])
    expect(live.liveFor('dm', 'dm1')).toBeNull()
  })

  it('the ring stops by itself when the ring window closes', () => {
    const { live, sources } = connected()
    const seen: number[] = []
    live.subscribe(() => seen.push(live.ringing.length))
    sources[0].frame('call.ringing', call())
    vi.advanceTimersByTime(44_000)
    expect(live.ringing).toHaveLength(1)
    vi.advanceTimersByTime(1_000)
    expect(live.ringing).toEqual([])
    expect(seen).toEqual([1, 0])
  })

  it('dismiss stops ringing locally at once (after accept or decline)', () => {
    const { live, sources } = connected()
    sources[0].frame('call.ringing', call())
    live.dismiss('c1')
    expect(live.ringing).toEqual([])
    expect(live.liveFor('dm', 'dm1')?.id).toBe('c1')
  })

  it('a reconnect starts from the fresh snapshot: calls that ended meanwhile are gone', () => {
    const { live, sources } = connected()
    sources[0].frame('call.ringing', call())
    sources[0].fail(false)
    expect(live.status).toBe('reconnecting')
    sources[0].open()
    expect(live.liveFor('dm', 'dm1')).toBeNull()
    expect(live.status).toBe('live')
  })

  it('a stream the browser gave up on is reopened after a pause; a server error frame is surfaced', () => {
    const { live, sources } = connected()
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    sources[0].serverError('could not load your calls; reload')
    expect(live.error).toBe('could not load your calls; reload')
    expect(errors).toHaveBeenCalled()
    sources[0].fail(true)
    expect(sources).toHaveLength(1)
    vi.advanceTimersByTime(5_000)
    expect(sources).toHaveLength(2)
    expect(sources[0].closed).toBe(true)
    sources[1].open()
    expect(live.error).toBeNull()
    errors.mockRestore()
  })

  it('close stops everything: no frames, no timers, no reconnects', () => {
    const { live, sources } = connected()
    sources[0].frame('call.ringing', call())
    live.close()
    expect(sources[0].closed).toBe(true)
    sources[0].frame('call.ringing', call({ id: 'c2', contextId: 'dm2' }))
    expect(live.liveFor('dm', 'dm2')).toBeNull()
    vi.advanceTimersByTime(60_000)
    expect(sources).toHaveLength(1)
  })
})
