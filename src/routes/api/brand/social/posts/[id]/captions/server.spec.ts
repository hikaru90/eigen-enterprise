import { beforeEach, describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { InMemorySocialPostStore } from '../../../../../../../../modules/brand/social/store'
import { InMemoryBrandStore } from '../../../../../../../../modules/brand/store'

/**
 * The caption endpoint end to end over the real suggest path with a mocked
 * gateway: the live wiring (stores, company provider, llm client) swapped for
 * in-memory stores and a scripted model.
 */

const { gateway, state } = vi.hoisted(() => ({
  gateway: vi.fn(),
  state: { posts: null as unknown, brand: null as unknown },
}))

vi.mock('$lib/server/llm/llm-client', () => ({ llmChatCompletion: gateway }))
vi.mock('$lib/server/llm/company-provider', () => ({
  onCompanyProvider: (run: () => unknown) => run(),
}))
vi.mock('../../../../../../../../modules/brand/social/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  defaultSocialPostStore: () => state.posts,
}))
vi.mock('../../../../../../../../modules/brand/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  defaultBrandStore: () => state.brand,
}))

const { POST } = await import('./+server')

async function call(postId: string, body: unknown, user: { id: string } | null = { id: 'ana' }) {
  return POST({
    locals: { user },
    params: { id: postId },
    request: new Request('http://x/', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json' },
    }),
  } as never)
}

describe('POST /api/brand/social/posts/[id]/captions', () => {
  let postId: string
  beforeEach(async () => {
    gateway.mockReset()
    const posts = new InMemorySocialPostStore()
    state.posts = posts
    state.brand = new InMemoryBrandStore()
    const post = await posts.createGraphic(
      {
        title: 'Teaser',
        format: 'square',
        graphic: { headline: 'Soon', body: '', cta: '', mode: 'light' },
        networks: ['linkedin', 'x'],
      },
      { kind: 'user', userId: 'ana' },
    )
    postId = post.id
  })

  it('returns three variants per asked network from one gateway call', async () => {
    gateway.mockResolvedValueOnce({
      choices: [{ message: { content: JSON.stringify({ captions: { x: ['a', 'b', 'c'] } }) } }],
    })
    const res = await call(postId, { networks: ['x'] })
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({
      postId,
      locale: null,
      voice: false,
      captions: { x: ['a', 'b', 'c'] },
    })
    expect(gateway).toHaveBeenCalledTimes(1)
    expect(gateway.mock.calls[0][0]).toMatchObject({
      userId: 'ana',
      logContext: 'brand_social_captions',
      responseFormat: 'json_object',
    })
  })

  it('no AI provider → 503 with the plain sentence', async () => {
    gateway.mockRejectedValueOnce(new LlmNotConfiguredError('none'))
    const res = await call(postId, {})
    expect(res.status).toBe(503)
    const body = (await res.json()) as {
      message: string
      error: string
      agent: { attempted: string }
    }
    expect(body.message).toMatch(/no AI provider set up yet/)
    expect(body.error).toBe(body.message)
    expect(body.agent.attempted).toMatch(/^Suggesting captions for the social post /)
  })

  it('a network the post does not target → 400, no gateway call', async () => {
    const res = await call(postId, { networks: ['tiktok'] })
    expect(res.status).toBe(400)
    expect(gateway).not.toHaveBeenCalled()
  })

  it('an unknown field → 400; signed out → 401', async () => {
    expect((await call(postId, { tone: 'loud' })).status).toBe(400)
    await expect(call(postId, {}, null)).rejects.toMatchObject({ status: 401 })
  })
})
