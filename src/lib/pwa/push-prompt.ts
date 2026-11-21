/**
 * What the "notifications on this device" prompt should offer, from what the
 * browser can do (feature detection only).
 *
 * - ask: push works here and this device is not subscribed yet
 * - on: this device gets notifications
 * - denied: the person blocked notifications for this site
 * - install-first: a browser tab that only gets push once the app is
 *   installed (iPhone/iPad Safari: Share → Add to Home Screen)
 * - unsupported: no push on this device at all
 */

export type PushPromptState = 'ask' | 'on' | 'denied' | 'install-first' | 'unsupported'

export type PushEnvironment = {
  serviceWorker: boolean
  pushManager: boolean
  notification: boolean
  permission: NotificationPermission | null
  subscribed: boolean
  /** Running as the installed app (display-mode standalone / iOS navigator.standalone). */
  standalone: boolean
}

export function pushPromptState(env: PushEnvironment): PushPromptState {
  if (!env.serviceWorker) return 'unsupported'
  if (!env.pushManager || !env.notification) return env.standalone ? 'unsupported' : 'install-first'
  if (env.permission === 'denied') return 'denied'
  if (env.permission === 'granted' && env.subscribed) return 'on'
  return 'ask'
}

/**
 * Where a "Not now" is remembered. The installed app keeps its own: on
 * Android the browser and the installed app share storage, so a "Not now" in
 * a browser tab must not hide the prompt in the app, which may need its own
 * permission (bug 87f5b9f8). The browser key is unchanged from before.
 */
export function pushPromptDismissKey(state: PushPromptState, standalone: boolean): string {
  return `eigenenterprise:push-banner-dismissed:${standalone ? 'app:' : ''}${state}`
}

/** Running as the installed app (display-mode standalone / iOS navigator.standalone). */
export function isStandalone(): boolean {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    (navigator as Navigator & { standalone?: boolean }).standalone === true
  )
}

/** Reads the live browser into a PushEnvironment. */
export async function readPushEnvironment(): Promise<PushEnvironment> {
  const serviceWorker = 'serviceWorker' in navigator
  const pushManager = 'PushManager' in window
  const notification = 'Notification' in window
  const standalone = isStandalone()
  let subscribed = false
  if (serviceWorker && pushManager) {
    const registration = await navigator.serviceWorker.getRegistration()
    subscribed = Boolean(await registration?.pushManager.getSubscription())
  }
  return {
    serviceWorker,
    pushManager,
    notification,
    permission: notification ? Notification.permission : null,
    subscribed,
    standalone,
  }
}
