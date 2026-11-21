import postgres from 'postgres'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Bug 87f5b9f8 ("no notifications after adding the app to the home screen"):
 * a push to someone else is sent from the request of the person who acted
 * (the author of a message). push_subscription is row-level secured per user,
 * so reading the recipient's devices in the author's scope finds none — the
 * recipient never got a push, however their device was set up.
 * pushToPerson reads and prunes the recipient's devices in the recipient's
 * own scope. Real test DB with the app's RLS role; web-push itself is faked.
 */
const DATABASE_URL = process.env.DATABASE_URL?.trim()

const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }))
vi.mock('web-push', () => ({ default: { sendNotification: sendNotificationMock } }))
vi.mock('./vapid', () => ({ configureWebPush: () => {} }))

describe.skipIf(!DATABASE_URL)('a push to another person', () => {
  const tag = `${Date.now().toString(36)}_${Math.random().toString(16).slice(2, 8)}`
  const author = `push_author_${tag}`
  const recipient = `push_recipient_${tag}`
  const endpoint = `https://web.push.apple.com/${tag}`
  let operator: postgres.Sql
  let db: typeof import('$lib/server/db')

  beforeAll(async () => {
    db = await import('$lib/server/db')
    operator = postgres(DATABASE_URL!, { max: 1, prepare: false })
    for (const id of [author, recipient]) {
      await operator`
        insert into "user" (id, name, email, email_verified, onboarding_completed, role)
        values (${id}, ${id}, ${`${id}@test.local`}, true, true, 'member')`
    }
  })

  beforeEach(async () => {
    sendNotificationMock.mockReset()
    await operator`delete from push_subscription where user_id = ${recipient}`
    await operator`
      insert into push_subscription (user_id, endpoint, p256dh, auth, user_agent)
      values (${recipient}, ${endpoint}, 'p256', 'auth', 'iPhone home screen')`
  })

  afterAll(async () => {
    await operator`delete from "user" where id in (${author}, ${recipient})`
    await operator.end()
    await db.closeAppDbPool()
  })

  it('the recipient’s devices are invisible in the author’s scope (the root cause)', async () => {
    const { listPushSubscriptionsForUser } = await import('./subscription')
    const seen = await db.withDbUser(author, () => listPushSubscriptionsForUser(recipient))
    expect(seen).toEqual([])
  })

  it('pushToPerson reaches the recipient’s device from the author’s request', async () => {
    const { pushToPerson } = await import('./person')
    sendNotificationMock.mockResolvedValue(undefined)
    const result = await db.withDbUser(author, () =>
      pushToPerson(recipient, { title: 'Ada', body: 'hi', url: '/messages?c=1', tag: 'messages-1' }),
    )
    expect(result).toMatchObject({ sent: 1, failed: 0 })
    expect(sendNotificationMock).toHaveBeenCalledWith({ endpoint, keys: { p256dh: 'p256', auth: 'auth' } }, expect.any(String))
  })

  it('a device the push service says is gone is removed in the recipient’s scope', async () => {
    const { pushToPerson } = await import('./person')
    sendNotificationMock.mockRejectedValue({ statusCode: 410 })
    await expect(
      db.withDbUser(author, () => pushToPerson(recipient, { title: 'Ada', body: 'hi' })),
    ).rejects.toThrow(/Push delivery failed/)
    const rows = await operator`select id from push_subscription where user_id = ${recipient}`
    expect(rows).toHaveLength(0)
  })

  it('personHasPush answers in the recipient’s scope', async () => {
    const { personHasPush } = await import('./person')
    expect(await db.withDbUser(author, () => personHasPush(recipient))).toBe(true)
    await operator`delete from push_subscription where user_id = ${recipient}`
    expect(await db.withDbUser(author, () => personHasPush(recipient))).toBe(false)
  })

  it('is null (nothing sent) when the person has no device with notifications on', async () => {
    const { pushToPerson } = await import('./person')
    await operator`delete from push_subscription where user_id = ${recipient}`
    const result = await db.withDbUser(author, () => pushToPerson(recipient, { title: 'Ada', body: 'hi' }))
    expect(result).toBeNull()
    expect(sendNotificationMock).not.toHaveBeenCalled()
  })
})
