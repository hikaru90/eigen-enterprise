import { describe, expect, it } from 'vitest'
import { eventType, toCloudEvent } from './cloudevents'
import { emitKernelEvent, InMemoryEventSink } from './events'

describe('toCloudEvent', () => {
  it('sets required CloudEvents 1.0 attributes', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      type: 'tool.executed',
      payload: { tool: 'memory.echo' },
    })
    const ce = toCloudEvent(event, '/kindred/kernel')
    expect(ce.specversion).toBe('1.0')
    expect(ce.id).toBe(event.id)
    expect(ce.source).toBe('/kindred/kernel')
    expect(ce.type).toBe('tool.executed')
    expect(ce.time).toBe(event.ts)
  })

  it('maps a legacy KernelEvent losslessly', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      id: 'fixed-id',
      ts: '2026-01-01T00:00:00.000Z',
      type: 'tool.executed',
      principalId: 'p1',
      payload: { tool: 'memory.echo' },
    })
    expect(toCloudEvent(event, '/kindred/kernel')).toEqual({
      specversion: '1.0',
      id: 'fixed-id',
      source: '/kindred/kernel',
      type: 'tool.executed',
      time: '2026-01-01T00:00:00.000Z',
      datacontenttype: 'application/json',
      data: { tool: 'memory.echo' },
      principalid: 'p1',
    })
  })

  it('maps payload null to data null with datacontenttype', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      type: 'custom',
      payload: null,
    })
    const ce = toCloudEvent(event, '/kindred/kernel')
    expect(ce.data).toBeNull()
    expect(ce.datacontenttype).toBe('application/json')
  })

  it('omits the extension attribute when principalId is unset', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      type: 'custom',
      principalId: undefined,
      payload: null,
    })
    const ce = toCloudEvent(event, '/kindred/kernel')
    expect('principalid' in ce).toBe(false)
  })

  it('omits data and datacontenttype when payload is undefined', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, {
      type: 'custom',
      payload: undefined,
    })
    const ce = toCloudEvent(event, '/kindred/kernel')
    expect('data' in ce).toBe(false)
    expect('datacontenttype' in ce).toBe(false)
  })

  it('throws on empty or whitespace-only source', async () => {
    const sink = new InMemoryEventSink()
    const event = await emitKernelEvent(sink, { type: 'custom', payload: null })
    expect(() => toCloudEvent(event, '')).toThrow()
    expect(() => toCloudEvent(event, '   ')).toThrow()
  })
})

describe('eventType', () => {
  it('builds the reverse-DNS convention', () => {
    expect(eventType('memory', 'echoed')).toBe('com.eigenenterprise.memory.echoed')
  })

  it('throws on empty segments', () => {
    expect(() => eventType('', 'echoed')).toThrow()
    expect(() => eventType('memory', '')).toThrow()
    expect(() => eventType('  ', 'echoed')).toThrow()
  })
})
