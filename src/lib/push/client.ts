/** Browser helpers for Web Push subscription lifecycle. */

import { base64UrlToBytes } from './keys'

const SW_READY_TIMEOUT_MS = 20_000

function withTimeout<T>(promise: Promise<T>, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(message)), SW_READY_TIMEOUT_MS),
    ),
  ])
}

/** Ensures a controlling service worker exists (avoids hanging on `navigator.serviceWorker.ready`). */
export async function getPushServiceWorkerRegistration(): Promise<ServiceWorkerRegistration> {
  if (!('serviceWorker' in navigator)) {
    throw new Error('Service workers are not supported')
  }

  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) {
    throw new Error('Service worker is not available. Reload the page, then try enabling push again.')
  }

  if (registration.active) return registration

  if (registration.waiting) {
    registration.waiting.postMessage({ type: 'SKIP_WAITING' })
  }

  await withTimeout(
    new Promise<ServiceWorkerRegistration>((resolve, reject) => {
      const done = () => resolve(registration!)
      const worker = registration!.installing ?? registration!.waiting
      if (worker) {
        worker.addEventListener('statechange', () => {
          if (worker.state === 'activated') done()
        })
        if (worker.state === 'activated') {
          done()
          return
        }
      }
      void navigator.serviceWorker.ready.then(done).catch(reject)
    }),
    'Service worker did not activate. Reload the page and try again.',
  )

  return registration
}

export type PushSupportState =
  { supported: false; reason: string } | { supported: true; permission: NotificationPermission }

export function getPushSupportState(): PushSupportState {
  if (typeof window === 'undefined') {
    return { supported: false, reason: 'Not in browser' }
  }
  if (!('serviceWorker' in navigator)) {
    return { supported: false, reason: 'Service workers are not supported' }
  }
  if (!('PushManager' in window)) {
    return { supported: false, reason: 'Push notifications are not supported' }
  }
  if (!('Notification' in window)) {
    return { supported: false, reason: 'Notifications are not supported' }
  }
  return { supported: true, permission: Notification.permission }
}

export async function fetchVapidPublicKey(): Promise<string> {
  const res = await fetch('/api/push/vapid-public-key')
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const msg =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Failed to load VAPID public key (${res.status})`
    throw new Error(msg)
  }
  const data = (await res.json()) as { publicKey?: unknown }
  if (typeof data.publicKey !== 'string' || !data.publicKey.trim()) {
    throw new Error('Invalid VAPID public key response')
  }
  return data.publicKey.trim()
}

export async function subscribeToPush(): Promise<PushSubscriptionJSON> {
  const support = getPushSupportState()
  if (!support.supported) throw new Error(support.reason)

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    throw new Error('Notification permission was not granted')
  }

  const registration = await getPushServiceWorkerRegistration()
  const vapidPublicKey = await fetchVapidPublicKey()
  const subscription = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToBytes(vapidPublicKey),
  })

  const json = subscription.toJSON()
  if (!json.endpoint || !json.keys?.p256dh || !json.keys?.auth) {
    throw new Error('Push subscription is missing required fields')
  }
  return json
}

export async function getExistingPushSubscription(): Promise<PushSubscription | null> {
  const support = getPushSupportState()
  if (!support.supported) return null
  const registration = await navigator.serviceWorker.getRegistration()
  if (!registration) return null
  return registration.pushManager.getSubscription()
}

export async function unsubscribeFromPush(): Promise<string | null> {
  const existing = await getExistingPushSubscription()
  if (!existing) return null
  const endpoint = existing.endpoint
  await existing.unsubscribe()
  return endpoint
}

/** Stores this device's subscription; `replacesEndpoint`: the subscription it renews (that row is removed). */
export async function postSubscribe(
  subscription: PushSubscriptionJSON,
  options: { replacesEndpoint?: string } = {},
): Promise<void> {
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...subscription, ...options }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const msg =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Subscribe failed (${res.status})`
    if (msg.includes('Failed query:') || msg.includes('push_subscription')) {
      throw new Error(
        'Could not save notification settings for this device. Try again, or enable later in Settings.',
      )
    }
    throw new Error(msg)
  }
}

export async function postUnsubscribe(endpoint: string): Promise<void> {
  const res = await fetch('/api/push/unsubscribe', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ endpoint }),
  })
  if (!res.ok) {
    const body = await res.json().catch(() => null)
    const msg =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Unsubscribe failed (${res.status})`
    throw new Error(msg)
  }
}

/** A test notification to all of this person's devices, or the one with `deviceId`. */
export async function postTestPush(deviceId?: string): Promise<{ sent: number; failed: number; removed: number }> {
  const res = await fetch('/api/push/test', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(deviceId === undefined ? {} : { deviceId }),
  })
  const body = await res.json().catch(() => null)
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : `Test push failed (${res.status})`
    throw new Error(msg)
  }
  return body as { sent: number; failed: number; removed: number }
}
