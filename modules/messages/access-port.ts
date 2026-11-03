import type { Access, AccessStore } from '$lib/server/access'
import type { AccessAudit } from '$lib/server/access/service'

/**
 * The messages module's one seam onto the access contract
 * (plan/phase-workspace.md §2, `$lib/server/access`). Messages codes against
 * `AccessPort`; `accessPortFrom` adapts the real module, `FakeAccessPort`
 * stands in for unit tests.
 *
 * Mapping (C1): public channel = a company grant (view = read, edit = post);
 * private channel = people/group grants; the creator gets manage. DMs never
 * go through here (membership rows).
 */

export type AccessResourceType = 'channel' | 'folder' | 'file'
export type AccessLevel = 'view' | 'edit' | 'manage'
export type GrantSubject = { kind: 'user'; userId: string } | { kind: 'group'; groupId: string } | { kind: 'company' }
export type Grant = { resourceType: AccessResourceType; resourceId: string; subject: GrantSubject; level: AccessLevel }
export type GrantInput = { subject: GrantSubject; level: AccessLevel }

export type AccessGroup = { id: string; name: string; memberIds: string[] }

export type AccessPort = {
  /** Owner/admin always manage; otherwise the strongest grant. Fail closed. */
  canAccess(userId: string, resourceType: AccessResourceType, resourceId: string, level: AccessLevel): Promise<boolean>
  /** The actor needs view. */
  listGrants(actorId: string, resourceType: AccessResourceType, resourceId: string): Promise<Grant[]>
  /** Replaces the full set; the actor needs manage. */
  setGrants(actorId: string, resourceType: AccessResourceType, resourceId: string, grants: GrantInput[]): Promise<void>
  /**
   * The first grant set of a resource the actor has just created (a member
   * creating a channel holds no manage grant yet). Refuses once grants exist.
   */
  initGrants(creatorId: string, resourceType: AccessResourceType, resourceId: string, grants: GrantInput[]): Promise<void>
  /** Groups people can invite. */
  listGroups(): Promise<AccessGroup[]>
}

const RANK: Record<AccessLevel, number> = { view: 1, edit: 2, manage: 3 }
export const levelSatisfies = (held: AccessLevel, wanted: AccessLevel) => RANK[held] >= RANK[wanted]

/** Adapter over the real access module. `store` + `audit` are the module's own, used only by initGrants. */
export function accessPortFrom(deps: {
  access: Pick<Access, 'canAccess' | 'listGrants' | 'setGrants'>
  store: Pick<AccessStore, 'grantsOn' | 'replaceGrants' | 'existingUserIds' | 'existingGroupIds'>
  audit: AccessAudit
  listGroups: () => Promise<AccessGroup[]>
}): AccessPort {
  const { access, store, audit } = deps
  return {
    canAccess: (u, t, id, level) => access.canAccess(u, t, id, level),
    listGrants: (a, t, id) => access.listGrants(a, t, id),
    async setGrants(a, t, id, grants) {
      await access.setGrants(a, t, id, grants)
    },
    async initGrants(creatorId, t, id, grants) {
      if (await access.canAccess(creatorId, t, id, 'manage')) {
        await access.setGrants(creatorId, t, id, grants)
        return
      }
      if ((await store.grantsOn([{ resourceType: t, resourceId: id }])).length > 0) {
        throw new Error(`${t} ${id} already has grants; only a manager can change them`)
      }
      const userIds = grants.flatMap((g) => (g.subject.kind === 'user' ? [g.subject.userId] : []))
      const groupIds = grants.flatMap((g) => (g.subject.kind === 'group' ? [g.subject.groupId] : []))
      const [users, groups] = await Promise.all([store.existingUserIds(userIds), store.existingGroupIds(groupIds)])
      for (const u of userIds) if (!users.has(u)) throw new Error(`no such member: ${u}`)
      for (const g of groupIds) if (!groups.has(g)) throw new Error(`no such group: ${g}`)
      const next: Grant[] = grants.map((g) => ({ resourceType: t, resourceId: id, subject: g.subject, level: g.level }))
      await store.replaceGrants(t, id, next, creatorId)
      await audit({
        type: 'access.grants_set',
        principalId: creatorId,
        payload: {
          resourceType: t,
          resourceId: id,
          before: [],
          after: next.map((g) => ({
            subject: g.subject.kind === 'user' ? `user:${g.subject.userId}` : g.subject.kind === 'group' ? `group:${g.subject.groupId}` : 'company',
            level: g.level,
          })),
        },
      })
    },
    listGroups: deps.listGroups,
  }
}

/** The live port: the real access module, its Postgres store, kernel audit, member groups. */
export async function liveAccessPort(channelExists: (id: string) => Promise<boolean>): Promise<AccessPort> {
  const accessMod = await import('$lib/server/access')
  const { dbAccessStore } = await import('$lib/server/access/db-store')
  const { dbGroupStore } = await import('$lib/server/members/groups-db-store')
  accessMod.registerResourceResolver('channel', channelExists)
  return accessPortFrom({
    access: accessMod.access,
    store: dbAccessStore,
    audit: accessMod.kernelAudit,
    listGroups: async () => (await dbGroupStore.listGroups()).map((g) => ({ id: g.id, name: g.name, memberIds: g.memberIds })),
  })
}

/** In-memory AccessPort for tests: grants + roles + groups, contract semantics. */
export class FakeAccessPort implements AccessPort {
  readonly grants = new Map<string, Grant[]>()
  readonly roles = new Map<string, 'owner' | 'admin' | 'member'>()
  groups: AccessGroup[] = []

  private key(t: AccessResourceType, id: string) {
    return `${t}:${id}`
  }

  async canAccess(userId: string, t: AccessResourceType, id: string, level: AccessLevel): Promise<boolean> {
    const role = this.roles.get(userId)
    if (!role) return false
    const grants = this.grants.get(this.key(t, id))
    if (!grants) return false
    if (role === 'owner' || role === 'admin') return true
    return grants.some((g) => {
      const s = g.subject
      const applies =
        s.kind === 'company' ||
        (s.kind === 'user' && s.userId === userId) ||
        (s.kind === 'group' && this.groups.some((gr) => gr.id === s.groupId && gr.memberIds.includes(userId)))
      return applies && levelSatisfies(g.level, level)
    })
  }

  async listGrants(actorId: string, t: AccessResourceType, id: string): Promise<Grant[]> {
    if (!(await this.canAccess(actorId, t, id, 'view'))) throw new Error('forbidden')
    return [...(this.grants.get(this.key(t, id)) ?? [])]
  }

  async setGrants(actorId: string, t: AccessResourceType, id: string, grants: GrantInput[]): Promise<void> {
    if (!(await this.canAccess(actorId, t, id, 'manage'))) throw new Error('forbidden')
    this.grants.set(this.key(t, id), grants.map((g) => ({ resourceType: t, resourceId: id, ...g })))
  }

  async initGrants(_creator: string, t: AccessResourceType, id: string, grants: GrantInput[]): Promise<void> {
    if (this.grants.has(this.key(t, id))) throw new Error('already has grants')
    this.grants.set(this.key(t, id), grants.map((g) => ({ resourceType: t, resourceId: id, ...g })))
  }

  async listGroups(): Promise<AccessGroup[]> {
    return this.groups
  }
}
