import type { MessagesDeps } from '../../../../../../../../modules/messages/service'
import { describe, expect, it, vi } from 'vitest'
import { createChannel, postMessage, uploadAttachments } from '../../../../../../../../modules/messages/service'
import { depthFixture } from '../../../../../../../../modules/messages/test-fixtures'

/** GET /api/messages/messages/:id/voice/:fileId — a voice message's recording, for the conversation's members. */

const live = vi.hoisted(() => ({ deps: null as MessagesDeps | null }))
vi.mock('../../../../../../../../modules/messages/live', () => ({ messagesDeps: async () => live.deps }))

const { GET } = await import('./+server')

type Get = Parameters<typeof GET>[0]
const get = (user: { id: string } | null, messageId: string, fileId: string, headers: Record<string, string> = {}) =>
  GET({
    locals: { user },
    params: { id: messageId, fileId },
    request: new Request('http://x/api', { headers }),
  } as unknown as Get) as Promise<Response>

const bytes = new Uint8Array(Array.from({ length: 100 }, (_, i) => i))

async function setup() {
  const f = depthFixture()
  live.deps = f.deps
  const ch = await createChannel(f.deps, 'bea', { name: 'lead', private: true, userIds: ['owner'] })
  const { uploaded } = await uploadAttachments(f.deps, 'bea', ch.id, [{ name: 'Voice message.webm', mime: 'audio/webm;codecs=opus', bytes }])
  const { message } = await postMessage(f.deps, 'bea', ch.id, 'hi', { voiceClips: [{ fileId: uploaded[0].fileId, durationMs: 3000 }] })
  return { messageId: message.id, fileId: uploaded[0].fileId }
}

describe('GET voice recording', () => {
  it('a member gets the whole recording inline, as audio, never sniffed or cached', async () => {
    const { messageId, fileId } = await setup()
    const res = await get({ id: 'owner' }, messageId, fileId)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('audio/webm;codecs=opus')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('100')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })

  it('answers a byte range (the player seeks) with 206, and an impossible one with 416', async () => {
    const { messageId, fileId } = await setup()
    const part = await get({ id: 'bea' }, messageId, fileId, { range: 'bytes=10-19' })
    expect(part.status).toBe(206)
    expect(part.headers.get('content-range')).toBe('bytes 10-19/100')
    expect(part.headers.get('content-length')).toBe('10')
    expect([...new Uint8Array(await part.arrayBuffer())]).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19])

    const open = await get({ id: 'bea' }, messageId, fileId, { range: 'bytes=95-' })
    expect(open.status).toBe(206)
    expect(open.headers.get('content-range')).toBe('bytes 95-99/100')

    const tail = await get({ id: 'bea' }, messageId, fileId, { range: 'bytes=-5' })
    expect(tail.status).toBe(206)
    expect(tail.headers.get('content-range')).toBe('bytes 95-99/100')

    const beyond = await get({ id: 'bea' }, messageId, fileId, { range: 'bytes=200-300' })
    expect(beyond.status).toBe(416)
    expect(beyond.headers.get('content-range')).toBe('bytes */100')
  })

  it('someone outside the conversation gets 404; signed out, 401', async () => {
    const { messageId, fileId } = await setup()
    expect((await get({ id: 'carl' }, messageId, fileId)).status).toBe(404)
    expect((await get(null, messageId, fileId)).status).toBe(401)
  })
})
