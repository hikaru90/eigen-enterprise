import type { RequestHandler } from './$types'
import { error, json } from '@sveltejs/kit'
import { deleteTimelineItemForUser } from '$lib/server/memory/delete-thought'

/**
 * The trash icon of a Tasks / project row: deletes the thought behind the row for good — its
 * text, dates and links (deleteTimelineItemForUser). Until 2026-11 this archived; archiving is
 * the row's own Archive action (`POST /api/temporal-events/:id/action`).
 */
export const DELETE: RequestHandler = async (event) => {
  const user = event.locals.user
  if (!user) error(401, 'Unauthorized')

  const eventId = event.params.id?.trim()
  if (!eventId) error(400, 'Event id is required')

  const result = await deleteTimelineItemForUser(user.id, eventId)
  if (!result.ok) {
    if (result.reason === 'system_project_task') {
      error(
        409,
        `This task belongs to the company’s “${result.projectLabel}” project: change it there.`,
      )
    }
    error(404, 'That task is not in your Memory (anymore).')
  }
  return json({ deleted: true, summary: 'Deleted for good.' })
}
