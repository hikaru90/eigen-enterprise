import type { Pathname } from '$app/types'

export type MemorySurfaceTab = 'overview' | 'tasks' | 'reminders' | 'projects' | 'notes' | 'capture'

/**
 * The Memory module page's sub-navigation (phase-cohesion §3): one page at
 * /m/memory, every section its own URL under it (rule 5). The old
 * /memory/* and /capture URLs are gone (404), never redirected.
 * `description` is the one short line under the tabs saying what the current
 * tab holds (Contribute d5e61e1f): a few words, not an explanation.
 */
export const MEMORY_TABS: ReadonlyArray<{
  id: MemorySurfaceTab
  label: string
  href: Pathname
  description: string
}> = [
  {
    id: 'overview',
    label: 'Overview',
    href: '/m/memory',
    description: 'Your open tasks at a glance, each with its project.',
  },
  {
    id: 'tasks',
    label: 'Tasks',
    href: '/m/memory/tasks',
    description: 'Things to do, by day. Tick the circle to mark one done.',
  },
  {
    id: 'reminders',
    label: 'Reminders',
    href: '/m/memory/reminders',
    description: 'Things that come back every week. Due ones show under Needs you.',
  },
  {
    id: 'projects',
    label: 'Projects',
    href: '/m/memory/projects',
    description: 'Tasks grouped under a goal. The company Roadmap is pinned first.',
  },
  {
    id: 'notes',
    label: 'Notes',
    href: '/m/memory/notes',
    description: 'Longer text you write and keep, like a document.',
  },
  {
    id: 'capture',
    label: 'Capture',
    href: '/m/memory/capture',
    description: 'Jot down a thought quickly; it is sorted into tasks and projects for you.',
  },
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
