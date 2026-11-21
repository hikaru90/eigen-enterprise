import type { MemoryOwner } from '$lib/server/memory/memory-owners'
import { resolveProjectAccess } from '$lib/server/memory/memory-visibility'
import type { ProjectListItem } from '$lib/server/memory/project-list'
import { loadProjectForReader } from '$lib/server/memory/team-projects'
import {
  listTemporalEventsForUser,
  MAX_LIST_LIMIT,
  type TemporalEventListItem,
} from '$lib/server/memory/temporal-event-list'
import { validateNonEmptyEntityId } from '$lib/server/validation/mcp-args'

export type ProjectDetail = {
  project: ProjectListItem
  items: TemporalEventListItem[]
  owner: MemoryOwner
  /** The reader owns the project; a colleague's shared project is read-only. */
  editable: boolean
}

/**
 * Load one GTD project plus all of its timeline task/event items, as the
 * reader sees it: their own, or a colleague's shared project (its owner's
 * items, trimmed by row-level security to the shared tasks — plan/
 * shared-memory-voice-agent-tools.md §1). Null when it does not exist for them.
 */
export async function loadProjectDetail(
  readerId: string,
  projectEntityId: string,
): Promise<ProjectDetail | null> {
  const entityId = validateNonEmptyEntityId(projectEntityId, 'projectEntityId')
  const access = await resolveProjectAccess(readerId, entityId)
  if (!access) return null
  const project = await loadProjectForReader(readerId, access.ownerId, entityId)
  if (!project) return null

  const { items } = await listTemporalEventsForUser({
    userId: access.ownerId,
    status: 'all',
    includeTasks: true,
    range: 'all',
    limit: MAX_LIST_LIMIT,
  })

  const { owner, editable, ...catalog } = project
  return {
    project: catalog,
    items: items.filter((item) => item.projectEntityId === entityId),
    owner,
    editable,
  }
}
