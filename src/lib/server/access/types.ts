/**
 * The access contract (plan/phase-workspace.md §2) — one model for "who may
 * see/change this", consumed by Drive (folders, files) and Messages (channels).
 * See ./README.md for the exact API and the folder-chain rule.
 */
export const RESOURCE_TYPES = ['channel', 'folder', 'file'] as const
export type ResourceType = (typeof RESOURCE_TYPES)[number]

export const ACCESS_LEVELS = ['view', 'edit', 'manage'] as const
export type AccessLevel = (typeof ACCESS_LEVELS)[number]

export type Subject = { kind: 'user'; userId: string } | { kind: 'group'; groupId: string } | { kind: 'company' }

export type Grant = {
  resourceType: ResourceType
  resourceId: string
  subject: Subject
  level: AccessLevel
}

/**
 * Where a resource sits. `ancestors` are the ids of the folders that contain
 * the resource, NEAREST PARENT FIRST, up to the root (Drive resolves the
 * chain; this module never walks folders itself). A grant on any of those
 * folders applies to the resource. Valid for 'folder' and 'file' only.
 */
export type ResourceChain = { ancestors?: readonly string[] }

export const LEVEL_RANK: Record<AccessLevel, number> = { view: 1, edit: 2, manage: 3 }

export class AccessError extends Error {
  constructor(
    readonly code: 'forbidden' | 'invalid_grant' | 'unknown_resource_type' | 'invalid_chain',
    message: string,
  ) {
    super(message)
  }
}
