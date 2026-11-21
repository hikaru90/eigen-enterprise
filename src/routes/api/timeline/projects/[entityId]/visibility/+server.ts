import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import type { MemoryVisibility } from '$lib/server/db/schema'
import { isMemoryReadOnlyError } from '$lib/server/memory/memory-read-only'
import { ProjectVisibilityError, setProjectVisibility } from '$lib/server/memory/memory-visibility'
import { failed, refuse } from '$lib/server/memory/route-errors'

export type SetProjectVisibilityRequest = { private: boolean }
export type SetProjectVisibilityResponse = { entityId: string; visibility: MemoryVisibility }

/** The project's Private switch: the UI client of memory.set_project_visibility (same service). */
export const POST: RequestHandler = async (event) => {
  const ctx = { attempted: 'Switching a project between private and shared' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  const entityId = event.params.entityId?.trim()
  if (!entityId) return refuse(400, 'Entity id is required', ctx)

  let body: Partial<SetProjectVisibilityRequest>
  try {
    body = (await event.request.json()) as Partial<SetProjectVisibilityRequest>
  } catch {
    return refuse(400, 'Invalid JSON body', ctx)
  }
  if (typeof body.private !== 'boolean')
    return refuse(400, 'private (true or false) is required', ctx)

  try {
    const result = await setProjectVisibility(
      user.id,
      entityId,
      body.private ? 'private' : 'company',
    )
    return json(result satisfies SetProjectVisibilityResponse)
  } catch (err) {
    if (isMemoryReadOnlyError(err)) return refuse(403, err.message, ctx)
    if (err instanceof ProjectVisibilityError) return refuse(409, err.message, ctx)
    const message = err instanceof Error ? err.message : String(err)
    if (message === 'Project not found') return failed(404, err, ctx)
    throw err
  }
}
