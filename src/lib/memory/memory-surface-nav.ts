import type { Pathname } from '$app/types'
import { m } from '$lib/paraglide/messages.js'

export type MemorySurfaceTab = 'tasks' | 'projects' | 'documents' | 'reminders' | 'questions' | 'handover' | 'knows'

/**
 * The Memory module page's sub-navigation (phase-cohesion §3): one page under
 * /m/memory, every section its own URL (rule 5). Memory shows what the brain
 * holds (plan/concept-memory-one-door.md §2.2, decision 1): nothing is typed
 * in here — the Ask bar is the one door. There is no Overview tab: /m/memory
 * lands on Tasks. Documents keeps its /m/memory/notes URL and "What the brain
 * knows" keeps /m/memory/capture, so links already sent out (check-in pushes,
 * bookmarks) still land.
 * `label` and `description` are messages (en + de), read at render time;
 * `description` is the one line under the tabs saying what the tab holds.
 */
export const MEMORY_TABS: ReadonlyArray<{
  id: MemorySurfaceTab
  label: () => string
  href: Pathname
  description: () => string
}> = [
  {
    id: 'tasks',
    label: () => m.memory_tab_tasks(),
    href: '/m/memory/tasks',
    description: () => m.memory_tab_tasks_line(),
  },
  {
    id: 'projects',
    label: () => m.memory_tab_projects(),
    href: '/m/memory/projects',
    description: () => m.memory_tab_projects_line(),
  },
  {
    id: 'documents',
    label: () => m.memory_tab_notes(),
    href: '/m/memory/notes',
    description: () => m.memory_tab_documents_line(),
  },
  {
    id: 'reminders',
    label: () => m.memory_tab_reminders(),
    href: '/m/memory/reminders',
    description: () => m.memory_tab_reminders_line(),
  },
  {
    id: 'questions',
    label: () => m.memory_tab_questions(),
    href: '/m/memory/questions',
    description: () => m.memory_tab_questions_line(),
  },
  {
    id: 'handover',
    label: () => m.memory_tab_handover(),
    href: '/m/memory/handover',
    description: () => m.memory_tab_handover_line(),
  },
  {
    id: 'knows',
    label: () => m.memory_tab_knows(),
    href: '/m/memory/capture',
    description: () => m.memory_tab_knows_line(),
  },
]

/** Which Memory tab is current for a pathname (null outside the tabs). */
export function activeMemorySurfaceTab(pathname: string): MemorySurfaceTab | null {
  const path = pathname.replace(/\/+$/, '')
  for (const tab of MEMORY_TABS) {
    if (path === tab.href || path.startsWith(`${tab.href}/`)) return tab.id
  }
  return null
}
