import { describe, expect, it, vi } from 'vitest'
import { createMemoryRateLimiter } from './api-send'
import { handleMailSubscribe, SubscribeRefused, type MailSubscribeDeps } from './api-subscribe'

const LIST = '5b1d2c3e-4f50-4a6b-8c7d-9e0f1a2b3c4d'
const KEY = { id: 'key-1', name: 'app:website' }

function deps(over: Partial<MailSubscribeDeps> = {}): MailSubscribeDeps {
  return {
    canSendMail: vi.fn(async () => true),
    publicList: vi.fn(async (id: string) => (id === LIST ? { id: LIST } : null)),
    addContact: vi.fn(async () => ({ status: 'pending', created: true })),
    limiter: createMemoryRateLimiter({ limit: 100, windowMs: 60_000 }),
    audit: vi.fn(async () => {}),
    ...over,
  }
}

describe('handleMailSubscribe', () => {
  it('refuses without a key', async () => {
    const res = await handleMailSubscribe(deps(), {
      apiKey: null,
      body: { listId: LIST, email: 'a@b.co' },
    })
    expect(res.status).toBe(401)
  })

  it('refuses a key that may not send mail (a double opt-in list sends a confirmation)', async () => {
    const d = deps({ canSendMail: vi.fn(async () => false) })
    const res = await handleMailSubscribe(d, {
      apiKey: KEY,
      body: { listId: LIST, email: 'a@b.co' },
    })
    expect(res.status).toBe(403)
    expect(d.addContact).not.toHaveBeenCalled()
  })

  it('rejects unknown fields and a missing email', async () => {
    const d = deps()
    expect((await handleMailSubscribe(d, { apiKey: KEY, body: { listId: LIST } })).status).toBe(400)
    expect(
      (
        await handleMailSubscribe(d, {
          apiKey: KEY,
          body: { listId: LIST, email: 'a@b.co', tags: ['x'] },
        })
      ).status,
    ).toBe(400)
    expect(d.addContact).not.toHaveBeenCalled()
  })

  it('only adds to a list whose public sign-up is on, so a leaked key cannot fill private lists', async () => {
    const d = deps()
    const other = '00000000-0000-4000-8000-000000000000'
    const res = await handleMailSubscribe(d, {
      apiKey: KEY,
      body: { listId: other, email: 'a@b.co' },
    })
    expect(res.status).toBe(404)
    expect(d.addContact).not.toHaveBeenCalled()
  })

  it('adds the contact and says whether a confirmation mail is on its way', async () => {
    const d = deps()
    const res = await handleMailSubscribe(d, {
      apiKey: KEY,
      body: { listId: LIST, email: 'ada@example.com', firstName: 'Ada' },
    })
    expect(res).toEqual({ status: 200, body: { status: 'pending', created: true } })
    expect(d.addContact).toHaveBeenCalledWith(LIST, { email: 'ada@example.com', firstName: 'Ada' })
    expect(d.audit).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'ada@example.com', ok: true }),
    )
  })

  it('passes the list service refusal back as a 400 with its message', async () => {
    const d = deps({
      addContact: vi.fn(async () => {
        throw new SubscribeRefused('"nope" is not an email address.')
      }),
    })
    const res = await handleMailSubscribe(d, {
      apiKey: KEY,
      body: { listId: LIST, email: 'nope@x' },
    })
    expect(res.status).toBe(400)
    expect(res.body).toEqual({
      error: 'invalid_request',
      message: '"nope" is not an email address.',
    })
  })

  it('rate-limits per key', async () => {
    const d = deps({ limiter: createMemoryRateLimiter({ limit: 1, windowMs: 60_000 }) })
    const body = { listId: LIST, email: 'a@b.co' }
    expect((await handleMailSubscribe(d, { apiKey: KEY, body })).status).toBe(200)
    const res = await handleMailSubscribe(d, { apiKey: KEY, body })
    expect(res.status).toBe(429)
    expect(res.headers?.['Retry-After']).toBeDefined()
  })
})
