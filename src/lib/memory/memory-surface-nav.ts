export type MemorySurfaceTab = 'tasks' | 'projects' | 'notes'

/**
 * Which Memory tab is active for a pathname (null outside them). The graph
 * view (/memory) is gone; notes, tasks and projects move into the Memory
 * module page in C3.
 */
export function activeMemorySurfaceTab(pathname: string): MemorySurfaceTab | null {
  if (pathname.startsWith('/memory/tasks')) return 'tasks'
  if (pathname.startsWith('/memory/projects')) return 'projects'
  if (pathname.startsWith('/memory/notes')) return 'notes'
  return null
}
