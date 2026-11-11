import type { Pathname } from '$app/types'

/**
 * Sub-navigation tabs for the shell's areas (one page frame, C3b): every
 * area page shows its tabs below the PageHeader. `match` lists the extra
 * path prefixes that belong to a tab (detail pages under it).
 */
export type AreaTab = {
  id: string
  label: string
  href: Pathname
  /** Further path prefixes that keep this tab current. */
  match?: readonly string[]
}

/**
 * The assistant's linkable pages (polish P-1): its conversations (the run
 * list, one run per conversation at /assistant/[id]) and the activity log.
 * The same two lists are the History and Activity tabs of the assistant panel.
 */
export const ASSISTANT_TABS: readonly AreaTab[] = [
  { id: 'conversations', label: 'Conversations', href: '/assistant', match: ['/assistant'] },
  { id: 'activity', label: 'Activity', href: '/assistant/activity' },
]

export const WEBSITE_TABS: readonly AreaTab[] = [
  { id: 'apps', label: 'Apps', href: '/m/website', match: ['/m/website/apps'] },
  { id: 'site', label: 'Site', href: '/m/website/site' },
  { id: 'settings', label: 'Settings', href: '/m/website/settings' },
]

export const BRAND_TABS: readonly AreaTab[] = [
  // The design system view (/brand/system) belongs to Style: its own tab only
  // sent you back to Style while no style was chosen (Contribute polish).
  { id: 'style', label: 'Style', href: '/brand', match: ['/brand/system'] },
  { id: 'material', label: 'Material', href: '/brand/material' },
  { id: 'extract', label: 'Extract', href: '/brand/extract' },
]

/** Drive (D1): your own files, what others shared with you, and the trash. */
export const DRIVE_TABS: readonly AreaTab[] = [
  { id: 'mine', label: 'My drive', href: '/drive', match: ['/drive/folder'] },
  { id: 'shared', label: 'Shared with me', href: '/drive/shared' },
  { id: 'trash', label: 'Trash', href: '/drive/trash' },
]

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/**
 * The current tab id for a pathname: a tab is current on its own href and,
 * for every tab but the area root, on pages below it; `match` adds prefixes.
 * The longest matching prefix wins, so a tab below the area root (e.g.
 * /assistant/activity) beats the root's catch-all match (/assistant).
 */
export function currentAreaTab(tabs: readonly AreaTab[], pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  let best: { id: string; len: number } | null = null
  const consider = (id: string, prefix: string) => {
    if (!best || prefix.length > best.len) best = { id, len: prefix.length }
  }
  for (const [i, tab] of tabs.entries()) {
    if (path === tab.href || (i > 0 && under(path, tab.href))) consider(tab.id, tab.href)
    for (const m of tab.match ?? []) if (under(path, m)) consider(tab.id, m)
  }
  return (best as { id: string } | null)?.id ?? null
}
