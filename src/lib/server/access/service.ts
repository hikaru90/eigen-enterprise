import type { MemberRole } from '$lib/server/auth/user-role'
import {
  ACCESS_LEVELS,
  AccessError,
  LEVEL_RANK,
  RESOURCE_TYPES,
  type AccessLevel,
  type Grant,
  type ResourceChain,
  type ResourceType,
  type Subject,
} from './types'

/** Storage + identity the access rules need (Postgres in production, memory in tests). */
export type AccessStore = {
  /** The user's company role, or null when no such user exists. */
  userRole(userId: string): Promise<MemberRole | null>
  /** Ids of the groups the user belongs to. */
  groupIdsOf(userId: string): Promise<string[]>
  /** Every grant on any of these resources. */
  grantsOn(targets: ReadonlyArray<{ resourceType: ResourceType; resourceId: string }>): Promise<Grant[]>
  /** Replace the full grant set of one resource (one transaction). */
  replaceGrants(resourceType: ResourceType, resourceId: string, grants: Grant[], grantedBy: string): Promise<void>
  /** Which of these user ids exist. */
  existingUserIds(ids: string[]): Promise<Set<string>>
  /** Which of these group ids exist. */
  existingGroupIds(ids: string[]): Promise<Set<string>>
}

/** Whether a resource of this type with this id exists (registered by the owning module: Drive, Messages). */
export type ResourceResolver = (resourceId: string) => Promise<boolean>

export type AccessAudit = (event: { type: string; principalId: string; payload: Record<string, unknown> }) => Promise<void>

export type AccessDeps = {
  store: AccessStore
  audit: AccessAudit
  resolvers?: Partial<Record<ResourceType, ResourceResolver>>
}

const isType = (t: unknown): t is ResourceType => RESOURCE_TYPES.includes(t as ResourceType)
const isLevel = (l: unknown): l is AccessLevel => ACCESS_LEVELS.includes(l as AccessLevel)

export function subjectKey(s: Subject): string {
  return s.kind === 'user' ? `user:${s.userId}` : s.kind === 'group' ? `group:${s.groupId}` : 'company'
}

export function createAccess(deps: AccessDeps) {
  const resolvers: Partial<Record<ResourceType, ResourceResolver>> = { ...deps.resolvers }

  function registerResourceResolver(resourceType: ResourceType, resolve: ResourceResolver): void {
    if (!isType(resourceType)) throw new AccessError('unknown_resource_type', `unknown resource type: ${String(resourceType)}`)
    resolvers[resourceType] = resolve
  }

  async function resourceExists(resourceType: ResourceType, resourceId: string): Promise<boolean> {
    const resolve = resolvers[resourceType]
    // Fail loud: a module that stores resources must say how to recognise them.
    if (!resolve) throw new AccessError('unknown_resource_type', `no resolver registered for resource type "${resourceType}"`)
    return resolve(resourceId)
  }

  function targetsOf(resourceType: ResourceType, resourceId: string, chain: ResourceChain | undefined) {
    const ancestors = chain?.ancestors ?? []
    if (ancestors.length > 0 && resourceType === 'channel') {
      throw new AccessError('invalid_chain', 'channels have no folder chain')
    }
    if (ancestors.some((a) => typeof a !== 'string' || a === '')) throw new AccessError('invalid_chain', 'folder chain has an empty id')
    return [
      { resourceType, resourceId },
      ...ancestors.map((id) => ({ resourceType: 'folder' as const, resourceId: id })),
    ]
  }

  /** The strongest level this user holds on the resource, or null. Fail closed on anything unknown. */
  async function effectiveLevel(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
    chain?: ResourceChain,
  ): Promise<AccessLevel | null> {
    if (!userId || !resourceId || !isType(resourceType)) return null
    const targets = targetsOf(resourceType, resourceId, chain)
    const role = await deps.store.userRole(userId)
    if (!role) return null
    if (!(await resourceExists(resourceType, resourceId))) return null
    if (role === 'owner' || role === 'admin') return 'manage'
    const [groups, grants] = await Promise.all([deps.store.groupIdsOf(userId), deps.store.grantsOn(targets)])
    const groupSet = new Set(groups)
    let best: AccessLevel | null = null
    for (const g of grants) {
      const applies =
        g.subject.kind === 'company' ||
        (g.subject.kind === 'user' && g.subject.userId === userId) ||
        (g.subject.kind === 'group' && groupSet.has(g.subject.groupId))
      if (applies && (!best || LEVEL_RANK[g.level] > LEVEL_RANK[best])) best = g.level
    }
    return best
  }

  /** Validates a grant set (levels, subjects, no duplicates, existing users/groups) into full grants. */
  async function validated(
    resourceType: ResourceType,
    resourceId: string,
    grants: ReadonlyArray<{ subject: Subject; level: AccessLevel }>,
  ): Promise<Grant[]> {
    const seen = new Set<string>()
    const next: Grant[] = []
    for (const g of grants) {
      if (!isLevel(g.level)) throw new AccessError('invalid_grant', `unknown access level: ${String(g.level)}`)
      const s = g.subject
      if (!s || !['user', 'group', 'company'].includes(s.kind)) throw new AccessError('invalid_grant', 'unknown subject kind')
      const key = subjectKey(s)
      if (seen.has(key)) throw new AccessError('invalid_grant', `${key} is listed twice`)
      seen.add(key)
      const subject: Subject =
        s.kind === 'user' ? { kind: 'user', userId: s.userId } : s.kind === 'group' ? { kind: 'group', groupId: s.groupId } : { kind: 'company' }
      next.push({ resourceType, resourceId, subject, level: g.level })
    }
    const userIds = next.flatMap((g) => (g.subject.kind === 'user' ? [g.subject.userId] : []))
    const groupIds = next.flatMap((g) => (g.subject.kind === 'group' ? [g.subject.groupId] : []))
    const [users, groups] = await Promise.all([deps.store.existingUserIds(userIds), deps.store.existingGroupIds(groupIds)])
    for (const id of userIds) if (!users.has(id)) throw new AccessError('invalid_grant', `no such member: ${id}`)
    for (const id of groupIds) if (!groups.has(id)) throw new AccessError('invalid_grant', `no such group: ${id}`)

    return next
  }

  function auditPayload(resourceType: ResourceType, resourceId: string, before: Grant[], after: Grant[]) {
    return {
      resourceType,
      resourceId,
      before: before.map((g) => ({ subject: subjectKey(g.subject), level: g.level })),
      after: after.map((g) => ({ subject: subjectKey(g.subject), level: g.level })),
    }
  }

  /**
   * The first grant set of a resource its creator has just made (a member who
   * creates a folder or channel holds no manage grant yet). Allowed only while
   * the resource exists and has no grants at all; the creator must be a known
   * user. Validated and audited exactly like setGrants (access.grants_set,
   * principal = creator). Once any grant exists, changes go through setGrants.
   */
  async function initializeGrants(
    creatorId: string,
    resourceType: ResourceType,
    resourceId: string,
    grants: ReadonlyArray<{ subject: Subject; level: AccessLevel }>,
    chain?: ResourceChain,
  ): Promise<Grant[]> {
    if (!creatorId || !resourceId || !isType(resourceType)) throw new AccessError('forbidden', 'Unknown creator or resource.')
    targetsOf(resourceType, resourceId, chain)
    if (!(await deps.store.userRole(creatorId))) throw new AccessError('forbidden', 'Unknown creator.')
    if (!(await resourceExists(resourceType, resourceId))) throw new AccessError('forbidden', 'No such resource.')
    if ((await deps.store.grantsOn([{ resourceType, resourceId }])).length > 0) {
      throw new AccessError('forbidden', 'This already has grants; only people who manage it can change them.')
    }
    const next = await validated(resourceType, resourceId, grants)
    await deps.store.replaceGrants(resourceType, resourceId, next, creatorId)
    await deps.audit({ type: 'access.grants_set', principalId: creatorId, payload: auditPayload(resourceType, resourceId, [], next) })
    return next
  }

  async function canAccess(
    userId: string,
    resourceType: ResourceType,
    resourceId: string,
    level: AccessLevel,
    chain?: ResourceChain,
  ): Promise<boolean> {
    if (!isLevel(level)) return false
    const have = await effectiveLevel(userId, resourceType, resourceId, chain)
    return have !== null && LEVEL_RANK[have] >= LEVEL_RANK[level]
  }

  async function listGrants(
    actorId: string,
    resourceType: ResourceType,
    resourceId: string,
    chain?: ResourceChain,
  ): Promise<Grant[]> {
    if (!(await canAccess(actorId, resourceType, resourceId, 'view', chain))) {
      throw new AccessError('forbidden', "You don't have access to this.")
    }
    return deps.store.grantsOn([{ resourceType, resourceId }])
  }

  async function setGrants(
    actorId: string,
    resourceType: ResourceType,
    resourceId: string,
    grants: ReadonlyArray<{ subject: Subject; level: AccessLevel }>,
    chain?: ResourceChain,
  ): Promise<Grant[]> {
    if (!(await canAccess(actorId, resourceType, resourceId, 'manage', chain))) {
      throw new AccessError('forbidden', 'Only people who manage this can change who has access.')
    }
    const next = await validated(resourceType, resourceId, grants)
    const before = await deps.store.grantsOn([{ resourceType, resourceId }])
    await deps.store.replaceGrants(resourceType, resourceId, next, actorId)
    await deps.audit({
      type: 'access.grants_set',
      principalId: actorId,
      payload: {
        resourceType,
        resourceId,
        before: before.map((g) => ({ subject: subjectKey(g.subject), level: g.level })),
        after: next.map((g) => ({ subject: subjectKey(g.subject), level: g.level })),
      },
    })
    return next
  }

  return { canAccess, effectiveLevel, listGrants, setGrants, initializeGrants, registerResourceResolver }
}

export type Access = ReturnType<typeof createAccess>
