import type { Pathname } from '$app/types'

export type MemorySurfaceTab = 'overview' | 'tasks' | 'projects' | 'notes' | 'capture'

/**
 * The Memory module page's sub-navigation (phase-cohesion §3): one page at
 * /m/memory, every section its own URL under it (rule 5). The old
 * /memory/* and /capture URLs are gone (404), never redirected.
 */
export const MEMORY_TABS: ReadonlyArray<{ id: MemorySurfaceTab; label: string; href: Pathname }> = [
  { id: 'overview', label: 'Overview', href: '/m/memory' },
  { id: 'tasks', label: 'Tasks', href: '/m/memory/tasks' },
  { id: 'projects', label: 'Projects', href: '/m/memory/projects' },
  { id: 'notes', label: 'Notes', href: '/m/memory/notes' },
  { id: 'capture', label: 'Capture', href: '/m/memory/capture' },
]

/** Which Memory tab is current for a pathname (null outside the Memory page). */
export function activeMemorySurfaceTab(pathname: string): MemorySurfaceTab | null {
  const path = pathname.replace(/\/+$/, '')
  if (path === '/m/memory') return 'overview'
  for (const tab of MEMORY_TABS) {
    if (tab.id !== 'overview' && (path === tab.href || path.startsWith(`${tab.href}/`)))
      return tab.id
  }
  return null
}
