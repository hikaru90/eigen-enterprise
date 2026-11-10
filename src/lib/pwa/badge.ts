/**
 * The app-icon badge (Badging API: installed apps on iOS 16.4+, desktop
 * Chrome/Edge). The count is the person's total unread across conversations —
 * the same numbers the Messages sidebar shows. The service worker sets it on
 * push; the Messages page keeps it current while open.
 */

export type BadgeNavigator = {
  setAppBadge?: (count: number) => Promise<void>
  clearAppBadge?: () => Promise<void>
}

export function totalUnread(conversations: ReadonlyArray<{ unread: number }>): number {
  return conversations.reduce((sum, c) => sum + c.unread, 0)
}

export async function syncAppBadge(count: number, nav: BadgeNavigator = navigator as BadgeNavigator): Promise<void> {
  if (!nav.setAppBadge || !nav.clearAppBadge) return
  try {
    await (count > 0 ? nav.setAppBadge(count) : nav.clearAppBadge())
  } catch (err) {
    console.error('[pwa] app badge update failed', err)
  }
}
