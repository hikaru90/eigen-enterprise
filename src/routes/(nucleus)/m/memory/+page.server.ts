import type { PageServerLoad } from './$types'
import { redirect } from '@sveltejs/kit'
import { isTaskListItem, listTemporalEventsForUser } from '$lib/server/memory/temporal-event-list'

export type MemoryTaskRow = {
  id: string
  summary: string
  project: { entityId: string; label: string } | null
}

/**
 * /m/memory: the Memory landing view — just the open tasks, each tagged with
 * its project. Settings live at /m/memory/settings (header, right side).
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) throw redirect(302, '/login')
  const { items } = await listTemporalEventsForUser({
    userId: event.locals.user.id,
    status: 'open',
    includeTasks: true,
    range: 'all',
    orderBy: 'todo',
  })
  const tasks: MemoryTaskRow[] = items.filter(isTaskListItem).map((item) => ({
    id: item.id,
    summary: item.semanticSummary,
    project:
      item.projectEntityId && item.projectLabel
        ? { entityId: item.projectEntityId, label: item.projectLabel }
        : null,
  }))
  return { tasks }
}
