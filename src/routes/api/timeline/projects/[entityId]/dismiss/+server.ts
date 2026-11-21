import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { dismissProject } from '$lib/server/memory/project-list'
import { failed, refuse } from '$lib/server/memory/route-errors'

export const POST: RequestHandler = async (event) => {
  const ctx = { attempted: 'Dismissing a project' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  const entityId = event.params.entityId?.trim()
  if (!entityId) return refuse(400, 'Entity id is required', ctx)

  try {
    await dismissProject(user.id, entityId)
    return json({ ok: true, summary: 'Project dismissed.' })
  } catch (err) {
    return failed(400, err, ctx)
  }
}
