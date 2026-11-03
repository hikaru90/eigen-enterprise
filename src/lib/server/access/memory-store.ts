import type { MemberRole } from '$lib/server/auth/user-role'
import type { AccessStore } from './service'
import type { Grant } from './types'

/** In-memory AccessStore (tests). */
export function memoryAccessStore(init: {
  users?: Record<string, MemberRole>
  groups?: Record<string, string[]>
  grants?: Grant[]
} = {}): AccessStore & { users: Record<string, MemberRole>; groups: Record<string, string[]>; grants: Grant[] } {
  const s = {
    users: { ...init.users },
    groups: { ...init.groups },
    grants: [...(init.grants ?? [])],
    async userRole(id: string) {
      return s.users[id] ?? null
    },
    async groupIdsOf(userId: string) {
      return Object.entries(s.groups)
        .filter(([, members]) => members.includes(userId))
        .map(([id]) => id)
    },
    async grantsOn(targets: ReadonlyArray<{ resourceType: string; resourceId: string }>) {
      return s.grants.filter((g) => targets.some((t) => t.resourceType === g.resourceType && t.resourceId === g.resourceId))
    },
    async replaceGrants(resourceType: string, resourceId: string, grants: Grant[]) {
      s.grants = [...s.grants.filter((g) => !(g.resourceType === resourceType && g.resourceId === resourceId)), ...grants]
    },
    async existingUserIds(ids: string[]) {
      return new Set(ids.filter((id) => id in s.users))
    },
    async existingGroupIds(ids: string[]) {
      return new Set(ids.filter((id) => id in s.groups))
    },
  }
  return s
}
