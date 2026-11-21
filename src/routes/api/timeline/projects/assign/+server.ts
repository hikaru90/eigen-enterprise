import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import { assignThoughtToProject } from '$lib/server/memory/assign-thought-project'
import { failed, refuse } from '$lib/server/memory/route-errors'

export type AssignProjectRequest = {
  thoughtId: string
  projectEntityId?: string
  projectLabel?: string
}

export type AssignProjectResponse = {
  projectEntityId: string
  projectLabel: string
  eligible: boolean
  created: boolean
  isGtdProject: boolean
}

export const POST: RequestHandler = async (event) => {
  const ctx = { attempted: 'Assigning a task to a project' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  let body: AssignProjectRequest
  try {
    body = (await event.request.json()) as AssignProjectRequest
  } catch {
    return refuse(400, 'Invalid JSON body', ctx)
  }

  const thoughtId = body.thoughtId?.trim()
  if (!thoughtId) return refuse(400, 'thoughtId is required', ctx)

  const projectEntityId = body.projectEntityId?.trim()
  const projectLabel = body.projectLabel?.trim()
  if (projectEntityId && projectLabel) {
    return refuse(400, 'Provide projectEntityId or projectLabel, not both', ctx)
  }
  if (!projectEntityId && !projectLabel) {
    return refuse(400, 'projectEntityId or projectLabel is required', ctx)
  }

  try {
    const result = await assignThoughtToProject(
      user.id,
      thoughtId,
      projectEntityId ? { projectEntityId } : { projectLabel: projectLabel! },
    )
    return json(result satisfies AssignProjectResponse)
  } catch (err) {
    return failed(400, err, ctx)
  }
}
