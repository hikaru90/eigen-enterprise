import { withDbUser } from '$lib/server/db'
import { sendPushToUser, type PushNotificationPayload, type SendPushResult } from './send'
import { listPushSubscriptionsForUser } from './subscription'

/**
 * A push to a person, from wherever it is sent (bug 87f5b9f8). Their devices
 * (push_subscription, row-level secured per user) are read — and pruned when
 * a push service says one is gone — in their own scope, never in the scope of
 * whoever caused the push: in the author's scope the recipient has no devices
 * and nothing would ever be sent.
 *
 * null: the person has no device with notifications on (nothing was sent).
 * Delivery failures throw, as sendPushToUser does.
 */
export async function pushToPerson(
  userId: string,
  payload: PushNotificationPayload,
): Promise<SendPushResult | null> {
  return withDbUser(userId, async () => {
    if ((await listPushSubscriptionsForUser(userId)).length === 0) return null
    return sendPushToUser(userId, payload)
  })
}

/** Whether the person has at least one device with notifications on (read in their own scope). */
export async function personHasPush(userId: string): Promise<boolean> {
  return withDbUser(userId, async () => (await listPushSubscriptionsForUser(userId)).length > 0)
}
