import type { MessagesDeps } from '../../../../../../../modules/messages/service'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createChannel, postMessage } from '../../../../../../../modules/messages/service'
import { fixture } from '../../../../../../../modules/messages/test-fixtures'

/** POST /api/messages/conversations/:id/messages — quoted replies (Contribute 2a58bcc8). */

const live = vi.hoisted(() => ({ deps: null as MessagesDeps | null, pushed: [] as unknown[] }))
vi.mock('../../../../../../../modules/messages/live', () => ({
  messagesDeps: async () => live.deps,
  pushNewMessage: (_d: unknown, _c: unknown, m: unknown) => void live.pushed.push(m),
}))

const { POST } = await import('./+server')

type Post = Parameters<typeof POST>[0]
const post = (userId: string, conversationId: string, body: unknown) =>
  POST({
    locals: { user: { id: userId } },
    params: { id: conversationId },
    request: new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) }),
  } as unknown as Post) as Promise<Response>

describe('POST messages with replyToId', () => {
  beforeEach(() => {
    live.pushed = []
  })

  it('posts a quoted reply and pushes it live with its quote', async () => {
    const f = fixture()
    live.deps = f.deps
    const ch = await createChannel(f.deps, 'owner', { name: 'general', private: false })
    const { message: original } = await postMessage(f.deps, 'bea', ch.id, 'hello')
    const res = await post('carl', ch.id, { body: 'hi back', replyToId: original.id })
    expect(res.status).toBe(200)
    const { message } = (await res.json()) as { message: { replyTo: { id: string; snippet: string } } }
    expect(message.replyTo).toMatchObject({ id: original.id, snippet: 'hello' })
    expect(live.pushed).toHaveLength(1)
  })

  it('refuses a message of another conversation (404) and a non-string id (400)', async () => {
    const f = fixture()
    live.deps = f.deps
    const a = await createChannel(f.deps, 'owner', { name: 'a', private: false })
    const b = await createChannel(f.deps, 'owner', { name: 'b', private: false })
    const { message: inA } = await postMessage(f.deps, 'bea', a.id, 'elsewhere')
    expect((await post('bea', b.id, { body: 'x', replyToId: inA.id })).status).toBe(404)
    expect((await post('bea', b.id, { body: 'x', replyToId: 42 })).status).toBe(400)
    expect(live.pushed).toEqual([])
  })
})
