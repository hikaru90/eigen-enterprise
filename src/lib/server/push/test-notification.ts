import type { NotificationsPort, TestNotificationResult } from '$lib/kernel/notification-tools'
import { withDbUser } from '$lib/server/db'
import {
  loadNotificationSettings,
  parseNotificationSettingsBody,
  saveNotificationSettings,
} from '$lib/server/settings/notification-settings'
import { sendPushToUser, type PushNotificationPayload } from './send'
import { listPushDevicesForUser } from './subscription'

/**
 * The person's own notification devices and the test notification: one
 * effect for Settings → Account → Notifications (/api/push/test) and the
 * registry tools notifications.devices / notifications.test. Always read and
 * sent in the person's own RLS scope.
 */

export const TEST_NOTIFICATION: PushNotificationPayload = {
  title: 'Test notification',
  body: 'If you can read this, notifications work on this device.',
  url: '/settings',
  tag: 'eigen-test',
}

/** Throws when nothing was delivered: no device (or not that one), or every push service refused. */
export async function sendTestNotification(userId: string, deviceId?: string): Promise<TestNotificationResult> {
  const r = await withDbUser(userId, () =>
    sendPushToUser(userId, TEST_NOTIFICATION, deviceId === undefined ? {} : { deviceId }),
  )
  return { sent: r.sent, failed: r.failed, removed: r.removed }
}

export const liveNotificationsPort: NotificationsPort = {
  devices: (userId) => withDbUser(userId, () => listPushDevicesForUser(userId)),
  sendTest: sendTestNotification,
  loadSettings: loadNotificationSettings,
  // The same parse and save as /api/settings/notifications and /m/memory/settings ?/settings.
  saveSettings: (userId, input) => saveNotificationSettings(userId, parseNotificationSettingsBody(input)),
}
