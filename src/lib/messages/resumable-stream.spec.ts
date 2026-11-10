import { describe, expect, it, vi } from 'vitest'
import { ResumableStream, type StreamSource } from './resumable-stream'

const CLOSED = 2

class FakeSource implements StreamSource {
  readyState = 0
  listeners = new Map<string, (e: MessageEvent) => void>()
  closed = false
  constructor(public url: string) {}
  addEventListener(type: string, fn: (e: MessageEvent) => void) {
    this.listeners.set(type, fn)
  }
  close() {
    this.closed = true
    this.readyState = CLOSED
  }
  emit(type: string, data: unknown, lastEventId: string) {
    this.listeners.get(type)?.({ data: JSON.stringify(data), lastEventId } as MessageEvent)
  }
}

function setup() {
  const sources: FakeSource[] = []
  const onEvent = vi.fn()
  const onStatus = vi.fn()
  const stream = new ResumableStream({
    url: (after) => `/api/messages/stream?after=${after}`,
    initialCursor: 10,
    events: ['message', 'read'],
    onEvent,
    onStatus,
    create: (url) => {
      const s = new FakeSource(url)
      sources.push(s)
      return s
    },
  })
  return { stream, sources, onEvent, onStatus }
}

describe('ResumableStream', () => {
  it('connects from the page cursor and hands events over with their type', () => {
    const { stream, sources, onEvent } = setup()
    stream.connect()
    expect(sources[0].url).toBe('/api/messages/stream?after=10')
    sources[0].emit('message', { a: 1 }, '11')
    expect(onEvent).toHaveBeenCalledWith('message', { a: 1 })
  })

  it('reports live and reconnecting', () => {
    const { stream, sources, onStatus } = setup()
    stream.connect()
    sources[0].listeners.get('open')?.({} as MessageEvent)
    sources[0].listeners.get('error')?.({} as MessageEvent)
    expect(onStatus.mock.calls.map((c) => c[0])).toEqual(['live', 'reconnecting'])
  })

  it('a stream the browser gave up on (phone woke up) resumes after the last event seen', () => {
    const { stream, sources } = setup()
    stream.connect()
    sources[0].emit('read', {}, '42')
    sources[0].readyState = CLOSED
    stream.resume()
    expect(sources).toHaveLength(2)
    expect(sources[0].closed).toBe(true)
    expect(sources[1].url).toBe('/api/messages/stream?after=42')
  })

  it('leaves a stream that is still open or reconnecting on its own', () => {
    const { stream, sources } = setup()
    stream.connect()
    sources[0].readyState = 1
    stream.resume()
    sources[0].readyState = 0
    stream.resume()
    expect(sources).toHaveLength(1)
  })

  it('close stops it for good', () => {
    const { stream, sources } = setup()
    stream.connect()
    stream.close()
    stream.resume()
    expect(sources).toHaveLength(1)
    expect(sources[0].closed).toBe(true)
  })
})
