import type { MemoryVisibility, ProjectStatus } from '$lib/server/db/schema'
import { applyProjectVisibility } from '$lib/server/memory/memory-visibility'
import { ensureProject } from '$lib/server/memory/project-eligibility'
import { promoteHubEntityType, upsertGraphHubEntity } from '$lib/server/memory/project-entity'

export type CreateUserProjectInput = {
  userId: string
  label: string
  status?: ProjectStatus
  /** Default 'company': every member sees it and its tasks. 'private' = the person only. */
  visibility?: MemoryVisibility
}

export type CreateUserProjectResult = {
  entityId: string
  label: string
  status: ProjectStatus
  visibility: MemoryVisibility
}

/** Create a GTD project from explicit user declaration (no LLM identity judge). */
export async function createUserDeclaredProject(
  input: CreateUserProjectInput,
): Promise<CreateUserProjectResult> {
  const label = input.label.trim()
  if (!label) {
    throw new Error('createUserDeclaredProject: label is required')
  }

  const status = input.status ?? 'active'

  const entityId = await upsertGraphHubEntity(input.userId, label, 'project')
  await promoteHubEntityType(input.userId, entityId, label)
  await ensureProject(input.userId, entityId, status, 'manual')
  const visibility = input.visibility ?? 'company'
  await applyProjectVisibility(input.userId, entityId, visibility)

  return {
    entityId,
    label,
    status,
    visibility,
  }
}
