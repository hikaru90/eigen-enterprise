import { beforeEach, describe, expect, it, vi } from 'vitest'

const { handleMock } = vi.hoisted(() => ({ handleMock: vi.fn() }))
vi.mock('$lib/server/mail/api-send', () => ({ handleMailSend: handleMock }))
vi.mock('$lib/server/mail/api-send-store', () => ({ mailSendDeps: () => ({}) }))

import { POST } from './+server'

function event(locals: Record<string, unknown>, body = '{"to":"a@example.com"}') {
  return {
    locals,
    request: new Request('http://localhost/api/mail/send', { method: 'POST', body }),
  } as unknown as Parameters<typeof POST>[0]
}

beforeEach(() => {
  handleMock.mockReset()
  handleMock.mockResolvedValue({
    status: 200,
    body: { id: 'x', status: 'sent', to: 'a@example.com' },
  })
})

describe('POST /api/mail/send', () => {
  it('rejects a cookie session (user without apiKeyAuth) with 401', async () => {
    const res = await POST(event({ user: { id: 'u1' } }))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'unauthorized' })
    expect(handleMock).not.toHaveBeenCalled()
  })

  it('rejects no auth (a bad key never resolves apiKeyAuth) with 401', async () => {
    const res = await POST(event({}))
    expect(res.status).toBe(401)
  })

  it('passes the key and body through and keeps headers', async () => {
    handleMock.mockResolvedValue({
      status: 429,
      body: { error: 'rate_limited' },
      headers: { 'Retry-After': '7' },
    })
    const res = await POST(event({ user: { id: 'u1' }, apiKeyAuth: { id: 'k', name: 'n' } }))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('7')
    expect(handleMock.mock.calls[0][1]).toEqual({
      apiKey: { id: 'k', name: 'n' },
      body: { to: 'a@example.com' },
    })
  })

  it('non-JSON body is 400 invalid_request', async () => {
    const res = await POST(
      event({ user: { id: 'u1' }, apiKeyAuth: { id: 'k', name: 'n' } }, 'nope'),
    )
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ error: 'invalid_request' })
  })
})
