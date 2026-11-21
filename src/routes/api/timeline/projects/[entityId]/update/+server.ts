import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { updateProjectLabel } from '$lib/server/memory/project-list'
import { failed, refuse } from '$lib/server/memory/route-errors'

export type UpdateProjectRequest = {
  label: string
}

export type UpdateProjectResponse = {
  entityId: string
  label: string
}

export const PUT: RequestHandler = async (event) => {
  const ctx = { attempted: 'Renaming a project' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  const entityId = event.params.entityId?.trim()
  if (!entityId) return refuse(400, 'Entity id is required', ctx)

  let body: UpdateProjectRequest
  try {
    body = (await event.request.json()) as UpdateProjectRequest
  } catch {
    return refuse(400, 'Invalid JSON body', ctx)
  }

  const label = body.label?.trim()
  if (!label) return refuse(400, 'label is required', ctx)

  try {
    const result = await updateProjectLabel(user.id, entityId, label)
    return json(result satisfies UpdateProjectResponse)
  } catch (err) {
    return failed(400, err, ctx)
  }
}
