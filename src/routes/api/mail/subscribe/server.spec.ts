import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))
vi.mock('$lib/server/mail/api-subscribe', () => ({ handleMailSubscribe: handleMock }))
vi.mock('$lib/server/mail/api-subscribe-store', () => ({ mailSubscribeDeps: () => ({}) }))

import { POST } from './+server'

function event(locals: Record<string, unknown>, body = '{"email":"a@example.com"}') {
  return {
    locals,
    request: new Request('http://localhost/api/mail/subscribe', { method: 'POST', body }),
  } as unknown as Parameters<typeof POST>[0]
}

beforeEach(() => {
  handleMock.mockReset()
  handleMock.mockResolvedValue({ status: 200, body: { status: 'pending', created: true } })
})

describe('POST /api/mail/subscribe', () => {
  it('rejects a cookie session (no apiKeyAuth) with 401', async () => {
    const res = await POST(event({ user: { id: 'u1' } }))
    expect(res.status).toBe(401)
    expect(handleMock).not.toHaveBeenCalled()
  })

  it('rejects a body that is not JSON with 400', async () => {
    const res = await POST(
      event({ user: { id: 'u1' }, apiKeyAuth: { id: 'k', name: 'n' } }, 'email=a'),
    )
    expect(res.status).toBe(400)
    expect(handleMock).not.toHaveBeenCalled()
  })

  it('passes the key and body through and keeps headers', async () => {
    handleMock.mockResolvedValue({
      status: 429,
      body: { error: 'rate_limited' },
      headers: { 'Retry-After': '9' },
    })
    const res = await POST(event({ user: { id: 'u1' }, apiKeyAuth: { id: 'k', name: 'n' } }))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('9')
    expect(handleMock.mock.calls[0][1]).toEqual({
      apiKey: { id: 'k', name: 'n' },
      body: { email: 'a@example.com' },
    })
  })
})
