import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import type { MemoryVisibility } from '$lib/server/db/schema'
import { isMemoryReadOnlyError } from '$lib/server/memory/memory-read-only'
import { ProjectVisibilityError, setProjectVisibility } from '$lib/server/memory/memory-visibility'

export type SetProjectVisibilityRequest = { private: boolean }
export type SetProjectVisibilityResponse = { entityId: string; visibility: MemoryVisibility }

/** The project's Private switch: the UI client of memory.set_project_visibility (same service). */
export const POST: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) error(401, 'Unauthorized')

  const entityId = event.params.entityId?.trim()
  if (!entityId) error(400, 'Entity id is required')

  let body: Partial<SetProjectVisibilityRequest>
  try {
    body = (await event.request.json()) as Partial<SetProjectVisibilityRequest>
  } catch {
    error(400, 'Invalid JSON body')
  }
  if (typeof body.private !== 'boolean') error(400, 'private (true or false) is required')

  try {
    const result = await setProjectVisibility(user.id, entityId, body.private ? 'private' : 'company')
    return json(result satisfies SetProjectVisibilityResponse)
  } catch (err) {
    if (isMemoryReadOnlyError(err)) error(403, err.message)
    if (err instanceof ProjectVisibilityError) error(409, err.message)
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'Project not found') error(404, message)
    throw err
  }
}
