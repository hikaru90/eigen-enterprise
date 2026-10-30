import { describe, expect, it, vi } from 'vitest'
import { runEventsResponse } from './sse'
import { fakeEventStream } from './test-fixtures'

async function readFrames(reader: ReadableStreamDefaultReader<Uint8Array>, count: number) {
  const decoder = new TextDecoder()
  let buffer = ''
  const frames: Array<{ event: string; data: unknown }> = []
  while (frames.length < count) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    let at: number
    while ((at = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, at)
      buffer = buffer.slice(at + 2)
      if (raw.startsWith(':')) continue
      const event = /^event: (.*)$/m.exec(raw)?.[1] ?? ''
      const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? 'null')
      frames.push({ event, data })
    }
  }
  return frames
}

describe('runEventsResponse', () => {
  it('sends the snapshot on connect, then one batch per commit', async () => {
    const fake = fakeEventStream()
    const res = runEventsResponse(fake.stream, new AbortController().signal)
    expect(res.headers.get('content-type')).toBe('text/event-stream')
    const reader = res.body!.getReader()

    const [first] = await readFrames(reader, 1)
    expect(first).toEqual({ event: 'snapshot', data: { running: false, items: [] } })

    await fake.emit([{ type: 'run_start', inputs: [] }])
    await fake.emit([
      { type: 'message_update', usage: {}, changes: [{ type: 'text_delta', contentIndex: 0, delta: 'Hi' }] },
    ])
    const next = await readFrames(reader, 2)
    expect(next).toEqual([
      { event: 'batch', data: { items: [{ kind: 'run_start' }] } },
      { event: 'batch', data: { items: [{ kind: 'text_delta', delta: 'Hi' }] } },
    ])
    await reader.cancel()
  })

  it('replaces the feed when the watch overflows into a snapshot', async () => {
    const fake = fakeEventStream()
    const reader = runEventsResponse(fake.stream, new AbortController().signal).body!.getReader()
    await readFrames(reader, 1)
    await fake.emit([{ type: 'snapshot', entries: [], tools: [], nestedTools: [], compactions: [], inbox: [], agent: {}, usage: {}, run: { inputs: [] } }])
    expect(await readFrames(reader, 1)).toEqual([
      { event: 'snapshot', data: { running: true, items: [] } },
    ])
    await reader.cancel()
  })

  it('stops the watcher when the client disconnects (stream cancel)', async () => {
    const fake = fakeEventStream()
    const reader = runEventsResponse(fake.stream, new AbortController().signal).body!.getReader()
    await readFrames(reader, 1)
    await reader.cancel()
    expect(fake.stop).toHaveBeenCalledTimes(1)
  })

  it('stops the watcher when the request aborts', async () => {
    const fake = fakeEventStream()
    const abort = new AbortController()
    const reader = runEventsResponse(fake.stream, abort.signal).body!.getReader()
    await readFrames(reader, 1)
    abort.abort()
    await vi.waitFor(() => expect(fake.stop).toHaveBeenCalledTimes(1))
  })

  it('ends the response when the watch closes on its own', async () => {
    const fake = fakeEventStream()
    const reader = runEventsResponse(fake.stream, new AbortController().signal).body!.getReader()
    await readFrames(reader, 1)
    fake.close()
    expect(await readFrames(reader, 1)).toEqual([{ event: 'end', data: {} }])
    expect((await reader.read()).done).toBe(true)
  })
})
