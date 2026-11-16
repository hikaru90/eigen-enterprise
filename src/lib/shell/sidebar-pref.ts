/**
 * The desktop sidebar's collapsed state (Contribute ff714496), remembered per
 * browser like the assistant panel's width. Storage is a per-viewer
 * convenience: it may be missing or throw (private mode, blocked site data)
 * and the sidebar then shows expanded.
 */

export const SIDEBAR_COLLAPSED_KEY = 'ee.shell-sidebar-collapsed'

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>

export function readSidebarCollapsed(storage: () => StorageLike): boolean {
  try {
    return storage().getItem(SIDEBAR_COLLAPSED_KEY) === '1'
  } catch {
    return false // storage unavailable: expanded
  }
}

export function writeSidebarCollapsed(storage: () => StorageLike, collapsed: boolean): void {
  try {
    storage().setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0')
  } catch {
    // storage unavailable: the choice lasts for this page view only
  }
}

/** ⌘\ / Ctrl+\ — matched on the physical key, so it works on every keyboard layout. */
export function isSidebarToggleKey(event: KeyboardEvent): boolean {
  if (!(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return false
  return event.code === 'Backslash' || event.key === '\\'
}
