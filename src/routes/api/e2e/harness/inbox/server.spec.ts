import { describe, expect, it, vi } from 'vitest'

const state = { dev: false }
vi.mock('$app/environment', () => ({
  get dev() {
    return state.dev
  },
}))

const { POST } = await import('./+server')
const post = (data: unknown) =>
  POST({ request: new Request('http://x/', { method: 'POST', body: JSON.stringify(data) }) } as never) as Promise<Response>

describe('POST /api/e2e/harness/inbox (dev only)', () => {
  it('is refused outside dev mode', async () => {
    state.dev = false
    expect((await post({ email: 'a@b.test', messages: [] })).status).toBe(403)
  })

  it('refuses a malformed body', async () => {
    state.dev = true
    await expect(post({ email: 'not-an-email', messages: [] })).rejects.toMatchObject({ status: 400 })
  })
})
