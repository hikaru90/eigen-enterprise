/**
 * Re-validating this device's push subscription on every app start (bug
 * 87f5b9f8). The browser can hold a subscription the server no longer has —
 * pruned after a 404/410, removed with the account's other rows, or renewed by
 * the browser while no page was open — and the page would then say
 * notifications are on while nothing arrives. So each start:
 *
 *   - register: re-posts the existing subscription (an idempotent upsert; it
 *     also refreshes the device's "last seen" in Settings);
 *   - resubscribe: the subscription was made with another VAPID key (the
 *     server's keys changed): pushes to it are refused, so it is replaced;
 *   - none: no subscription or no permission — turning notifications on is
 *     the person's own tap (iOS only allows the permission prompt from one),
 *     offered by the notifications banner.
 *
 * Pure decision here, browser wiring in syncPushSubscriptionOnStart.
 */

import { fetchVapidPublicKey, getPushServiceWorkerRegistration, getPushSupportState, postSubscribe } from './client'
import { base64UrlToBytes, bytesToBase64Url } from './keys'

export type StartupPushAction = 'none' | 'register' | 'resubscribe'

export type StartupPushInput = {
  permission: NotificationPermission | null
  /** This device's current subscription; serverKey = its applicationServerKey (base64url) when the browser exposes it. */
  local: { endpoint: string; serverKey: string | null } | null
  /** The server's VAPID public key (base64url). */
  vapidKey: string
}

export function startupPushAction(input: StartupPushInput): StartupPushAction {
  if (input.permission !== 'granted' || !input.local) return 'none'
  if (input.local.serverKey !== null && input.local.serverKey !== input.vapidKey) return 'resubscribe'
  return 'register'
}

/** Runs once per app start (src/routes/+layout.svelte, after the worker is registered). */
export async function syncPushSubscriptionOnStart(): Promise<StartupPushAction> {
  const support = getPushSupportState()
  if (!support.supported || support.permission !== 'granted') return 'none'
  const registration = await getPushServiceWorkerRegistration()
  const existing = await registration.pushManager.getSubscription()
  if (!existing) return 'none'

  const vapidKey = await fetchVapidPublicKey()
  const key = existing.options?.applicationServerKey
  const action = startupPushAction({
    permission: support.permission,
    local: { endpoint: existing.endpoint, serverKey: key ? bytesToBase64Url(key) : null },
    vapidKey,
  })
  if (action === 'register') {
    await postSubscribe(existing.toJSON())
  } else if (action === 'resubscribe') {
    const old = existing.endpoint
    await existing.unsubscribe()
    const next = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(vapidKey),
    })
    await postSubscribe(next.toJSON(), { replacesEndpoint: old })
  }
  return action
}
