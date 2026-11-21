import { describe, expect, it, vi } from 'vitest'
import { POST } from './+server'

const { sendTestNotificationMock } = vi.hoisted(() => ({
  sendTestNotificationMock: vi.fn(),
}))

vi.mock('$lib/server/push/test-notification', () => ({
  sendTestNotification: sendTestNotificationMock,
}))

const post = (user: { id: string } | null, body?: unknown) =>
  POST({
    locals: { user },
    request: new Request('http://localhost/api/push/test', {
      method: 'POST',
      ...(body === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
    }),
  } as never)

describe('POST /api/push/test', () => {
  it('returns 401 when unauthenticated', async () => {
    await expect(post(null)).rejects.toMatchObject({ status: 401 })
  })

  it('sends a test notification to all of the current user’s devices', async () => {
    sendTestNotificationMock.mockResolvedValue({ sent: 2, failed: 0, removed: 0 })
    const res = await post({ id: 'u1' })
    expect(sendTestNotificationMock).toHaveBeenCalledWith('u1', undefined)
    expect(await res.json()).toMatchObject({ ok: true, sent: 2 })
  })

  it('sends to one device when the body names it', async () => {
    sendTestNotificationMock.mockResolvedValue({ sent: 1, failed: 0, removed: 0 })
    await post({ id: 'u1' }, { deviceId: 'd1' })
    expect(sendTestNotificationMock).toHaveBeenCalledWith('u1', 'd1')
  })

  it('rejects a deviceId that is not a string', async () => {
    await expect(post({ id: 'u1' }, { deviceId: 3 })).rejects.toMatchObject({ status: 400 })
  })

  it('returns 400 when the user has no subscriptions (or not that device)', async () => {
    sendTestNotificationMock.mockRejectedValue(
      new Error('No push subscriptions registered for this account'),
    )
    await expect(post({ id: 'u1' })).rejects.toMatchObject({ status: 400 })
    sendTestNotificationMock.mockRejectedValue(
      new Error('No push subscription with id d9 for this account'),
    )
    await expect(post({ id: 'u1' }, { deviceId: 'd9' })).rejects.toMatchObject({ status: 400 })
  })

  it('returns 503 when VAPID is not configured', async () => {
    sendTestNotificationMock.mockRejectedValue(new Error('VAPID_PUBLIC_KEY is required'))
    await expect(post({ id: 'u1' })).rejects.toMatchObject({
      status: 503,
      body: {
        message: 'VAPID_PUBLIC_KEY is required',
        agent: {
          attempted: 'Sending a test notification (POST /api/push/test)',
          cause: 'VAPID_PUBLIC_KEY is required',
        },
      },
    })
  })
})
