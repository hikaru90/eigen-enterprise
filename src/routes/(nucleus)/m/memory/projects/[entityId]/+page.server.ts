import type { PageServerLoad } from './$types'
import { error, redirect } from '@sveltejs/kit'
import { parseProjectTaskStatusFilter } from '$lib/memory/project-task-status-filter'
import { parseProjectViewMode } from '$lib/memory/project-view-mode'
import { resolveProjectAccess } from '$lib/server/memory/memory-visibility'
import { loadProjectDetail } from '$lib/server/memory/project-detail'
import { getUserPreferredTimezone } from '$lib/server/memory/user-timezone'

/** Project entity ids are uuids; anything else cannot exist (and would 500 in the query). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * One project: the person's own (editable, with its Private switch) or a
 * colleague's shared one (read-only, with its owner — plan/
 * shared-memory-voice-agent-tools.md §1). A private project of someone else
 * does not exist for the reader (404).
 */
export const load: PageServerLoad = async (event) => {
  if (!event.locals.user) {
    throw redirect(302, '/login')
  }

  const entityId = event.params.entityId?.trim()
  if (!entityId || !UUID_RE.test(entityId)) error(404, 'Project not found')

  // The Roadmap system project has its own board page (P-4), whoever opens it.
  const access = await resolveProjectAccess(event.locals.user.id, entityId)
  if (access?.systemKey === 'roadmap') redirect(307, '/m/memory/projects/roadmap')

  event.depends('timeline:temporal-events', 'timeline:thoughts', `project:${entityId}`)

  const detail = await loadProjectDetail(event.locals.user.id, entityId)
  if (!detail) error(404, 'Project not found')

  const view = parseProjectViewMode(event.url.searchParams.get('view'))
  const statusFilter = parseProjectTaskStatusFilter(event.url.searchParams.get('status'))
  const preferredTimezone = await getUserPreferredTimezone(event.locals.user.id)

  return {
    user: event.locals.user,
    preferredTimezone,
    view,
    statusFilter,
    project: detail.project,
    items: detail.items,
    owner: detail.owner,
    editable: detail.editable,
  }
}
