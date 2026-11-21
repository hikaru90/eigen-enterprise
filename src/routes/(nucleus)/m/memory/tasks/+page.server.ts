import type { Actions, PageServerLoad } from './$types'
import { error, fail, redirect } from '@sveltejs/kit'
import { errorReport } from '$lib/server/errors/report'
import { assignedTaskDeps } from '$lib/server/memory/assigned-tasks/live'
import {
  AssignedTaskError,
  commentOnTask,
  completeTask,
  listTasks,
  markTaskSeen,
} from '$lib/server/memory/assigned-tasks/service'
import { loadTimelinePageData } from '../../../../timeline/timeline-page-load'

/**
 * Memory › Tasks: the person's own tasks (the timeline, from their private
 * Memory) and the tasks assigned between members (assigned to them, and by
 * them) — the second list is a company-level record both people read.
 */
export const load: PageServerLoad = async (event) => {
  const timeline = await loadTimelinePageData(event)
  return { ...timeline, assigned: await listTasks(await assignedTaskDeps(), timeline.user.id) }
}

function signedIn(locals: App.Locals): string {
  if (!locals.user) throw redirect(302, '/login')
  return locals.user.id
}

function taskId(form: FormData): string {
  const id = form.get('task_id')
  if (typeof id !== 'string' || !id) throw error(400, 'task_id is required')
  return id
}

/** The service's refusals come back to the form as messages; anything else is a real failure. */
async function run(id: string, attempted: string, fn: () => Promise<unknown>) {
  try {
    await fn()
    return { taskId: id, ok: true as const }
  } catch (err) {
    if (err instanceof AssignedTaskError) {
      return fail(err.code === 'not_found' ? 404 : err.code === 'forbidden' ? 403 : 400, {
        taskId: id,
        ...errorReport(err, {
          attempted,
          input: { task_id: id },
          plain: (e) => (e instanceof Error ? e.message : String(e)),
        }),
      })
    }
    throw err
  }
}

export const actions: Actions = {
  complete: async ({ locals, request }) => {
    const userId = signedIn(locals)
    const id = taskId(await request.formData())
    return run(id, 'Completing an assigned task on /m/memory/tasks', async () =>
      completeTask(await assignedTaskDeps(), { userId, via: 'person' }, id),
    )
  },
  comment: async ({ locals, request }) => {
    const userId = signedIn(locals)
    const form = await request.formData()
    const id = taskId(form)
    const body = form.get('body')
    return run(id, 'Commenting on an assigned task on /m/memory/tasks', async () =>
      commentOnTask(
        await assignedTaskDeps(),
        { userId, via: 'person' },
        id,
        typeof body === 'string' ? body : '',
      ),
    )
  },
  seen: async ({ locals, request }) => {
    const userId = signedIn(locals)
    const id = taskId(await request.formData())
    return run(id, 'Marking an assigned task as seen on /m/memory/tasks', async () =>
      markTaskSeen(await assignedTaskDeps(), userId, id),
    )
  },
}
