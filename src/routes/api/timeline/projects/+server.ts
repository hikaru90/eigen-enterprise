import type { RequestHandler } from './$types'
import { json } from '@sveltejs/kit'
import type { MemoryAuthor, MemoryVisibility, ProjectStatus } from '$lib/server/db/schema'
import { createUserDeclaredProject } from '$lib/server/memory/create-user-project'
import { listProjectsForUser, type ProjectListItem } from '$lib/server/memory/project-list'
import { failed, refuse } from '$lib/server/memory/route-errors'

export type TimelineProjectsResponse = {
  projects: ProjectListItem[]
}

export type CreateProjectRequest = {
  label: string
  status?: ProjectStatus
  /** true = only the person sees it and its tasks; default false = shared with everyone. */
  private?: boolean
}

export type CreateProjectResponse = {
  entityId: string
  label: string
  status: ProjectStatus
  visibility: MemoryVisibility
}

const PROJECT_STATUS_KEYS = ['active', 'someday', 'completed'] as const

function parseProjectStatus(value: unknown): ProjectStatus | undefined {
  return typeof value === 'string' && (PROJECT_STATUS_KEYS as readonly string[]).includes(value)
    ? (value as ProjectStatus)
    : undefined
}

export const GET: RequestHandler = async (event) => {
  const ctx = { attempted: 'Listing projects for the timeline' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  const authorParam = event.url.searchParams.get('author')
  const authorScope: MemoryAuthor | 'all' = authorParam === 'all' ? 'all' : 'user'

  const projects = await listProjectsForUser(user.id, { authorScope })
  return json({ projects } satisfies TimelineProjectsResponse)
}

export const POST: RequestHandler = async (event) => {
  const ctx = { attempted: 'Creating a project from the timeline' }
  const user = event.locals.user
  if (!user) return refuse(401, 'Unauthorized', ctx)

  let body: CreateProjectRequest
  try {
    body = (await event.request.json()) as CreateProjectRequest
  } catch {
    return refuse(400, 'Invalid JSON body', ctx)
  }

  const label = body.label?.trim()
  if (!label) return refuse(400, 'label is required', ctx)

  const status = parseProjectStatus(body.status)
  if (body.private !== undefined && typeof body.private !== 'boolean') {
    return refuse(400, 'private must be true or false', ctx)
  }

  try {
    const result = await createUserDeclaredProject({
      userId: user.id,
      label,
      ...(status ? { status } : {}),
      visibility: body.private === true ? 'private' : 'company',
    })
    return json(result satisfies CreateProjectResponse)
  } catch (err) {
    return failed(400, err, ctx)
  }
}
