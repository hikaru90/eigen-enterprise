import type { Actions, PageServerLoad } from './$types'
import { fail, redirect } from '@sveltejs/kit'
import { deleteThoughtForUser } from '$lib/server/memory/delete-thought'
import { isTaskListItem, listTemporalEventsForUser } from '$lib/server/memory/temporal-event-list'

export type MemoryTaskRow = {
  id: string
  /** The thought the task is: Delete removes it (and the task) for good. */
  thoughtId: string
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
    thoughtId: item.thoughtId,
    summary: item.semanticSummary,
    project:
      item.projectEntityId && item.projectLabel
        ? { entityId: item.projectEntityId, label: item.projectLabel }
        : null,
  }))
  return { tasks }
}

export const actions: Actions = {
  /** Delete a task for good: the thought it is, with everything derived from it. */
  deleteTask: async (event) => {
    if (!event.locals.user) return fail(401, { message: 'Sign in again to delete.' })
    const thoughtId = String((await event.request.formData()).get('thoughtId') ?? '').trim()
    if (!thoughtId) return fail(400, { message: 'Which task? None was given.' })
    const result = await deleteThoughtForUser(event.locals.user.id, thoughtId)
    if (!result.ok) {
      if (result.reason === 'system_project_task') {
        return fail(409, {
          message: `This task belongs to the company’s “${result.projectLabel}” project: change it there.`,
        })
      }
      return fail(404, { message: 'That task is not in your Memory (anymore).' })
    }
    return { deleted: true as const }
  },
}
