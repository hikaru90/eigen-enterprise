import { describe, expect, it } from 'vitest'
import { emitKernelEvent, InMemoryEventSink, type EventSink } from './events'

describe('emitKernelEvent', () => {
  it('orders events by (ts, id) in emission order, also within one millisecond (module event delivery reads that order)', async () => {
    const sink = new InMemoryEventSink()
    const emitted = []
    for (let i = 0; i < 200; i++) {
      emitted.push(await emitKernelEvent(sink, { type: 'contacts.created', payload: { i } }))
    }
    const byTsThenId = [...emitted].sort((a, b) => (a.ts !== b.ts ? (a.ts < b.ts ? -1 : 1) : a.id < b.id ? -1 : 1))
    expect(byTsThenId.map((e) => e.id)).toEqual(emitted.map((e) => e.id))
    // Still a UUID the kernel_events uuid column takes (version 7: time-ordered).
    for (const e of emitted) expect(e.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })

  it('fills id and ts and forwards the rest', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      type: 'tool.executed',
      principalId: 'p1',
      payload: { tool: 'memory.echo' },
    })
    expect(event.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(Number.isNaN(Date.parse(event.ts))).toBe(false)
    expect(event.type).toBe('tool.executed')
    expect(event.principalId).toBe('p1')
    expect(event.payload).toEqual({ tool: 'memory.echo' })
    expect(sink.events).toEqual([event])
  })

  it('honors explicitly provided id/ts', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      id: 'fixed-id',
      ts: '2026-01-01T00:00:00.000Z',
      type: 'approval.mode_changed',
      payload: null,
    })
    expect(event.id).toBe('fixed-id')
    expect(event.ts).toBe('2026-01-01T00:00:00.000Z')
    expect(event.principalId).toBeUndefined()
  })

  it('round-trips the source provenance', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      type: 'tool.executed',
      source: 'urn:eigenenterprise:module:memory',
      payload: null,
    })
    expect(event.source).toBe('urn:eigenenterprise:module:memory')
    expect(sink.events[0].source).toBe('urn:eigenenterprise:module:memory')
  })

  it('leaves source unset when the emit site provides none', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, { type: 'approval.mode_changed', payload: null })
    expect(event.source).toBeUndefined()
  })
})

describe('InMemoryEventSink', () => {
  it('retains emission order', async () => {
    const sink = new InMemoryEventSink()
    const ordered: EventSink = sink
    for (const type of ['a', 'b', 'c']) {
      await ordered.emit({ id: `id-${type}`, ts: new Date().toISOString(), type, payload: null })
    }
    expect(sink.events.map((e) => e.type)).toEqual(['a', 'b', 'c'])
  })

  it('refuses a type outside the core event catalog (the locked contract), and emits nothing', async () => {
    const sink = new InMemoryEventSink()
    await expect(
      emitKernelEvent(sink, { type: 'not.a_core_event' as never, payload: null }),
    ).rejects.toThrow(/not a core event type.*event-catalog\.ts.*contract:lock/)
    expect(sink.events).toEqual([])
  })
})
