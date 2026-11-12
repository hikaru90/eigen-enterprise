import { assertCompanyOnly, levelCovers, LEVEL_RANK, type AccessLevel, type DriveAccessPort, type Grant } from './access-port'

/**
 * In-memory DriveAccessPort for tests: the same rules as the access contract
 * (owner/admin always manage, strongest grant via user/group/company on the
 * resource or any folder above it, fail closed for unknown users).
 */
export type MemoryAccessOptions = {
  users: Record<string, { role: 'owner' | 'admin' | 'member'; name?: string; groups?: string[] }>
  groups?: Record<string, string>
}

export function memoryDriveAccess(opts: MemoryAccessOptions): DriveAccessPort & { grants: Grant[] } {
  const grants: Grant[] = []
  const effective = (userId: string, type: string, id: string): AccessLevel | null => {
    const user = opts.users[userId]
    let best: AccessLevel | null = null
    for (const g of grants) {
      if (g.resourceType !== type || g.resourceId !== id) continue
      const hit =
        (g.subject.kind === 'user' && g.subject.userId === userId) ||
        (g.subject.kind === 'group' && (user?.groups ?? []).includes(g.subject.groupId)) ||
        g.subject.kind === 'company'
      if (hit && (!best || LEVEL_RANK[g.level] > LEVEL_RANK[best])) best = g.level
    }
    return best
  }
  return {
    grants,
    async canAccess(userId, ref, level) {
      const user = opts.users[userId]
      if (!user) return false
      if (user.role === 'owner' || user.role === 'admin') return true
      const chain: Array<[string, string]> = [[ref.resourceType, ref.resourceId], ...ref.folderChain.map((f): [string, string] => ['folder', f])]
      return chain.some(([t, id]) => {
        const have = effective(userId, t, id)
        return have !== null && levelCovers(have, level)
      })
    },
    async listGrants(type, id) {
      return grants.filter((g) => g.resourceType === type && g.resourceId === id)
    },
    async initializeGrants(_creator, type, id, next) {
      if (grants.some((g) => g.resourceType === type && g.resourceId === id)) throw new Error(`${type} ${id} already has grants`)
      grants.push(...next)
    },
    async setGrants(_actor, type, id, next) {
      for (let i = grants.length - 1; i >= 0; i--) if (grants[i]!.resourceType === type && grants[i]!.resourceId === id) grants.splice(i, 1)
      grants.push(...next)
    },
    async shareTargets() {
      return {
        people: Object.entries(opts.users).map(([id, u]) => ({ id, name: u.name ?? id, email: `${id}@test` })),
        groups: Object.entries(opts.groups ?? {}).map(([id, name]) => ({ id, name })),
      }
    },
    async dropResource(_actor, type, id) {
      for (let i = grants.length - 1; i >= 0; i--) if (grants[i]!.resourceType === type && grants[i]!.resourceId === id) grants.splice(i, 1)
    },
    async systemGrants(_principal, type, id, next) {
      assertCompanyOnly(next)
      for (let i = grants.length - 1; i >= 0; i--) if (grants[i]!.resourceType === type && grants[i]!.resourceId === id) grants.splice(i, 1)
      grants.push(...next)
    },
  }
}
