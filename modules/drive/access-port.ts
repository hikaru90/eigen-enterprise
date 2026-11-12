import type { Access, AccessStore } from '$lib/server/access'
import { subjectKey, type AccessAudit } from '$lib/server/access/service'

/**
 * Drive's one seam onto the company access contract (src/lib/server/access,
 * plan/phase-workspace.md §2). Drive codes against DriveAccessPort only.
 *
 * Rules (the contract's): owner and admins always manage; otherwise the
 * strongest grant via the user, any of their groups or the whole company, on
 * the item or any folder above it (Drive passes the chain, nearest parent
 * first). Fail closed on anything unknown.
 */

export type AccessLevel = 'view' | 'edit' | 'manage'
export type GrantSubject = { kind: 'user'; userId: string } | { kind: 'group'; groupId: string } | { kind: 'company' }
export type ResourceType = 'channel' | 'folder' | 'file'
export type Grant = { resourceType: ResourceType; resourceId: string; subject: GrantSubject; level: AccessLevel }

/** A Drive item plus the folders above it, nearest first. */
export type DriveResourceRef = { resourceType: 'folder' | 'file'; resourceId: string; folderChain: readonly string[] }

export type ShareTargets = {
  people: Array<{ id: string; name: string; email: string }>
  groups: Array<{ id: string; name: string }>
}

export type DriveAccessPort = {
  canAccess(userId: string, ref: DriveResourceRef, level: AccessLevel): Promise<boolean>
  /** Grants set directly on this resource (not inherited ones). Drive has already checked manage. */
  listGrants(resourceType: 'folder' | 'file', resourceId: string): Promise<Grant[]>
  /** The first grants of an item its creator just made (a member creating a folder becomes its manager). */
  initializeGrants(creatorId: string, resourceType: 'folder' | 'file', resourceId: string, grants: Grant[]): Promise<void>
  /** Replaces the resource's direct grants (validated + audited; the contract checks the actor holds manage). */
  setGrants(actorId: string, resourceType: 'folder' | 'file', resourceId: string, grants: Grant[], folderChain: readonly string[]): Promise<void>
  /** Who a Share dialog can name: company members and groups. */
  shareTargets(): Promise<ShareTargets>
  /** Drop every grant on a resource about to be deleted forever (call while it still exists). */
  dropResource(actorId: string, resourceType: 'folder' | 'file', resourceId: string, folderChain: readonly string[]): Promise<void>
  /**
   * The system writer's grants (source folders, plan/github-drive.md §5): no
   * member acts, so the manage check is skipped; the change is audited with
   * `principalId` (the source id). Replaces the item's direct grants; only
   * the whole-company subject is accepted (a sync never names people).
   */
  systemGrants(principalId: string, resourceType: 'folder' | 'file', resourceId: string, grants: Grant[]): Promise<void>
}

/** systemGrants accepts the whole company only: a source never decides about people or groups. */
export function assertCompanyOnly(grants: readonly Grant[]): void {
  for (const g of grants) if (g.subject.kind !== 'company') throw new Error(`drive system grants name the whole company only, got a ${g.subject.kind} grant`)
}

export const LEVEL_RANK: Record<AccessLevel, number> = { view: 1, edit: 2, manage: 3 }

export function levelCovers(have: AccessLevel, need: AccessLevel): boolean {
  return LEVEL_RANK[have] >= LEVEL_RANK[need]
}

export type ContractDeps = {
  access: Pick<Access, 'canAccess' | 'setGrants' | 'initializeGrants'>
  store: Pick<AccessStore, 'grantsOn' | 'replaceGrants'>
  shareTargets: () => Promise<ShareTargets>
  /** Where systemGrants are recorded (the contract's own audit: kernel_events). */
  audit: AccessAudit
}

const inputs = (grants: Grant[]) => grants.map((g) => ({ subject: g.subject, level: g.level }))

/** The port over the real access module: Drive passes the folder chain (nearest parent first); the contract decides. */
export function contractDriveAccess(deps: ContractDeps): DriveAccessPort {
  const direct = (type: 'folder' | 'file', id: string) => deps.store.grantsOn([{ resourceType: type, resourceId: id }])
  return {
    canAccess: (userId, ref, level) => deps.access.canAccess(userId, ref.resourceType, ref.resourceId, level, { ancestors: ref.folderChain }),
    listGrants: direct,
    async initializeGrants(creatorId, type, id, grants) {
      await deps.access.initializeGrants(creatorId, type, id, inputs(grants))
    },
    async setGrants(actorId, type, id, grants, folderChain) {
      await deps.access.setGrants(actorId, type, id, inputs(grants), { ancestors: folderChain })
    },
    shareTargets: deps.shareTargets,
    async dropResource(actorId, type, id, folderChain) {
      if ((await direct(type, id)).length === 0) return
      await deps.access.setGrants(actorId, type, id, [], { ancestors: folderChain })
    },
    async systemGrants(principalId, type, id, grants) {
      assertCompanyOnly(grants)
      const before = await direct(type, id)
      await deps.store.replaceGrants(type, id, grants, principalId)
      const keys = (gs: Grant[]) => gs.map((g) => ({ subject: subjectKey(g.subject), level: g.level }))
      await deps.audit({ type: 'access.grants_set', principalId, payload: { resourceType: type, resourceId: id, before: keys(before), after: keys(grants) } })
    },
  }
}

let registered = false

/** The live port: the access module (Postgres), members and groups; registers Drive's resolvers once. */
export async function liveDriveAccess(): Promise<DriveAccessPort> {
  const accessMod = await import('$lib/server/access')
  const { dbAccessStore } = await import('$lib/server/access/db-store')
  const { dbDriveStore } = await import('./db-store')
  const { dbMemberStore } = await import('$lib/server/members/db-store')
  const { dbGroupStore } = await import('$lib/server/members/groups-db-store')
  const resolvers = {
    folder: async (id: string) => (await dbDriveStore.getFolder(id)) !== null,
    file: async (id: string) => (await dbDriveStore.getFile(id)) !== null,
  }
  if (!registered) {
    accessMod.registerResourceResolver('folder', resolvers.folder)
    accessMod.registerResourceResolver('file', resolvers.file)
    registered = true
  }
  return contractDriveAccess({
    access: accessMod.access,
    store: dbAccessStore,
    audit: accessMod.kernelAudit,
    shareTargets: async () => {
      const [members, groups] = await Promise.all([dbMemberStore.listMembers(), dbGroupStore.listGroups()])
      return { people: members.map((m) => ({ id: m.id, name: m.name, email: m.email })), groups: groups.map((g) => ({ id: g.id, name: g.name })) }
    },
  })
}
