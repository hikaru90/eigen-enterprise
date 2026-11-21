import { describe, expect, it, vi } from 'vitest'
import { POST } from './+server'

const { parsePushSubscriptionBodyMock, upsertPushSubscriptionMock, deleteByEndpointMock } =
  vi.hoisted(() => ({
    parsePushSubscriptionBodyMock: vi.fn(),
    upsertPushSubscriptionMock: vi.fn(),
    deleteByEndpointMock: vi.fn(),
  }))

vi.mock('$lib/server/push/subscription', () => ({
  parsePushSubscriptionBody: parsePushSubscriptionBodyMock,
  upsertPushSubscription: upsertPushSubscriptionMock,
  deletePushSubscriptionByEndpoint: deleteByEndpointMock,
  PUSH_SUBSCRIBE_USER_ERROR:
    'Could not save notification settings for this device. Try again, or enable later in Settings.',
}))

describe('POST /api/push/subscribe', () => {
  it('returns 401 when unauthenticated', async () => {
    await expect(
      POST({
        locals: { user: null },
        request: new Request('http://localhost/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ endpoint: 'https://x', keys: { p256dh: 'a', auth: 'b' } }),
        }),
      } as never),
    ).rejects.toMatchObject({ status: 401 })
  })

  it('persists subscription for authenticated user', async () => {
    parsePushSubscriptionBodyMock.mockReturnValue({
      endpoint: 'https://push.example/x',
      keys: { p256dh: 'p', auth: 'a' },
    })
    upsertPushSubscriptionMock.mockResolvedValue({ id: 'sub-1' })

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: new Request('http://localhost/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'user-agent': 'vitest' },
        body: JSON.stringify({
          endpoint: 'https://push.example/x',
          keys: { p256dh: 'p', auth: 'a' },
        }),
      }),
    } as never)

    expect(upsertPushSubscriptionMock).toHaveBeenCalledWith(
      'u1',
      { endpoint: 'https://push.example/x', keys: { p256dh: 'p', auth: 'a' } },
      'vitest',
    )
    expect(await res.json()).toEqual({ ok: true, id: 'sub-1' })
  })

  it('returns 400 for invalid subscription payload', async () => {
    parsePushSubscriptionBodyMock.mockImplementation(() => {
      throw new Error('endpoint is required')
    })

    await expect(
      POST({
        locals: { user: { id: 'u1' } },
        request: new Request('http://localhost/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({}),
        }),
      } as never),
    ).rejects.toMatchObject({ status: 400 })
  })

  it('returns a user-safe message when persist fails', async () => {
    parsePushSubscriptionBodyMock.mockReturnValue({
      endpoint: 'https://push.example/x',
      keys: { p256dh: 'p', auth: 'a' },
    })
    upsertPushSubscriptionMock.mockRejectedValue(
      new Error(
        'Failed query: insert into "push_subscription" ("id", "user_id") values (default, $1)',
      ),
    )

    await expect(
      POST({
        locals: { user: { id: 'u1' } },
        request: new Request('http://localhost/api/push/subscribe', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            endpoint: 'https://push.example/x',
            keys: { p256dh: 'p', auth: 'a' },
          }),
        }),
      } as never),
    ).rejects.toMatchObject({
      status: 500,
      body: {
        message:
          'Could not save notification settings for this device. Try again, or enable later in Settings.',
        agent: {
          attempted: 'Turning on notifications on this device (POST /api/push/subscribe)',
          cause: expect.stringContaining('Failed query'),
        },
      },
    })
  })

  it('a renewed subscription (pushsubscriptionchange) removes the endpoint it replaces', async () => {
    parsePushSubscriptionBodyMock.mockReturnValue({
      endpoint: 'https://push.example/new',
      keys: { p256dh: 'p', auth: 'a' },
    })
    upsertPushSubscriptionMock.mockResolvedValue({ id: 'sub-2' })
    deleteByEndpointMock.mockResolvedValue(true)

    const res = await POST({
      locals: { user: { id: 'u1' } },
      request: new Request('http://localhost/api/push/subscribe', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          endpoint: 'https://push.example/new',
          keys: { p256dh: 'p', auth: 'a' },
          replacesEndpoint: 'https://push.example/old',
        }),
      }),
    } as never)

    expect(deleteByEndpointMock).toHaveBeenCalledWith('https://push.example/old')
    expect(await res.json()).toEqual({ ok: true, id: 'sub-2' })
  })
})
