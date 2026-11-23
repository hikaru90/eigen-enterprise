import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { SLEEP_CONSOLIDATION_TASK_ID } from '$lib/server/scheduled-tasks/constants'
import { runScheduledTaskNow, stopScheduledTask } from '$lib/server/scheduled-tasks/run-now'
import { setUserScheduledTaskPaused } from '$lib/server/scheduled-tasks/service'

export const PATCH: RequestHandler = async ({ locals, params, request }) => {
  if (!locals.user) {
    error(401, 'Unauthorized')
  }

  const taskId = params.taskId
  if (!taskId) {
    error(400, 'taskId is required')
  }

  let body: { paused?: boolean }
  try {
    body = await request.json()
  } catch {
    error(400, 'Invalid JSON body')
  }

  if (typeof body.paused !== 'boolean') {
    error(400, 'Body must include paused: boolean')
  }

  try {
    await setUserScheduledTaskPaused(locals.user.id, taskId, body.paused)
    return json({ ok: true, paused: body.paused })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[scheduled-tasks] pause toggle failed', { taskId, message })
    return json({ ok: false, error: message }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    error(401, 'Unauthorized')
  }

  const taskId = params.taskId
  if (!taskId) {
    error(400, 'taskId is required')
  }

  if (taskId !== SLEEP_CONSOLIDATION_TASK_ID) {
    error(404, 'Unknown scheduled task')
  }

  try {
    const result = await runScheduledTaskNow(locals.user.id, taskId)
    return json(result, { status: result.ok ? 202 : 409 })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.error('[scheduled-tasks] run now failed', { taskId, message })
    return json({ ok: false, error: message }, { status: 500 })
  }
}

export const DELETE: RequestHandler = async ({ locals, params }) => {
  if (!locals.user) {
    error(401, 'Unauthorized')
  }

  const taskId = params.taskId
  if (!taskId) {
    error(400, 'taskId is required')
  }

  if (taskId !== SLEEP_CONSOLIDATION_TASK_ID) {
    error(404, 'Unknown scheduled task')
  }

  const result = await stopScheduledTask(locals.user.id, taskId)
  return json({
    ok: true,
    softCancelled: result.softCancelled,
    clearedStuck: result.clearedStuck,
    message: result.message,
  })
}
