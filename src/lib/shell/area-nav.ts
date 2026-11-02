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

export const AGENT_TABS: readonly AreaTab[] = [
  { id: 'runs', label: 'Runs', href: '/agent/runs', match: ['/agent/runs'] },
  { id: 'activity', label: 'Activity', href: '/agent/activity' },
  { id: 'roadmap', label: 'Roadmap', href: '/agent/roadmap' },
]

export const WEBSITE_TABS: readonly AreaTab[] = [
  { id: 'apps', label: 'Apps', href: '/m/website', match: ['/m/website/apps'] },
  { id: 'site', label: 'Site', href: '/m/website/site' },
  { id: 'settings', label: 'Settings', href: '/m/website/settings' },
]

export const BRAND_TABS: readonly AreaTab[] = [
  { id: 'style', label: 'Style', href: '/brand' },
  { id: 'system', label: 'Design system', href: '/brand/system' },
  { id: 'extract', label: 'Extract', href: '/brand/extract' },
]

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`)

/**
 * The current tab id for a pathname: a tab is current on its own href and,
 * for every tab but the area root, on pages below it; `match` adds prefixes.
 */
export function currentAreaTab(tabs: readonly AreaTab[], pathname: string): string | null {
  const path = pathname.replace(/\/+$/, '') || '/'
  for (const [i, tab] of tabs.entries()) {
    if (path === tab.href) return tab.id
    if (i > 0 && under(path, tab.href)) return tab.id
    if (tab.match?.some((m) => under(path, m))) return tab.id
  }
  return null
}
