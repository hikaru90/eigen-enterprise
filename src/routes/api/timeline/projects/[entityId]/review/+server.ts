import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import type { ReviewProjectResponse } from '$lib/memory/project-review-types'
import { reviewProject } from '$lib/server/memory/project-review'
import { failed, refuse } from '$lib/server/memory/route-errors'

export type { ReviewProjectResponse }

export type ReviewProjectRequest = {
  goal?: string
}

export const POST: RequestHandler = async (event) => {
  const ctx = { attempted: 'Reviewing a project with the AI' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  const entityId = event.params.entityId?.trim()
  if (!entityId) return refuse(400, 'Entity id is required', ctx)

  let body: ReviewProjectRequest = {}
  try {
    const text = await event.request.text()
    if (text.trim()) {
      body = JSON.parse(text) as ReviewProjectRequest
    }
  } catch {
    return refuse(400, 'Invalid JSON body', ctx)
  }

  try {
    const result = await reviewProject({
      userId: user.id,
      projectEntityId: entityId,
      ...(typeof body.goal === 'string' && body.goal.trim() ? { goal: body.goal.trim() } : {}),
    })
    return json(result satisfies ReviewProjectResponse)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (/not found/i.test(message)) return failed(404, err, ctx)
    return failed(400, err, ctx)
  }
}
