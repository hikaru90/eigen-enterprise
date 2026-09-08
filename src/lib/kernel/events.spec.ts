import { describe, expect, it } from 'vitest'
import { emitKernelEvent, InMemoryEventSink, type EventSink } from './events'

describe('emitKernelEvent', () => {
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
      type: 'custom',
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
    const event = await emitKernelEvent(sink, { type: 'custom', payload: null })
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
})
