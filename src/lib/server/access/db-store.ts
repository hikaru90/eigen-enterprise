import { randomUUID } from 'node:crypto'
import { and, eq, inArray, or } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { accessGrant, memberGroup, memberGroupMember } from '$lib/server/db/team.schema'
import type { MemberRole } from '$lib/server/auth/user-role'
import type { AccessStore } from './service'
import type { Grant, Subject } from './types'

type GrantRow = typeof accessGrant.$inferSelect

function toGrant(r: GrantRow): Grant {
  const subject: Subject =
    r.subjectKind === 'user'
      ? { kind: 'user', userId: r.subjectUserId! }
      : r.subjectKind === 'group'
        ? { kind: 'group', groupId: r.subjectGroupId! }
        : { kind: 'company' }
  return { resourceType: r.resourceType, resourceId: r.resourceId, subject, level: r.level }
}

/** AccessStore over Postgres (access_grant, member_group_member, user.role). */
export const dbAccessStore: AccessStore = {
  async userRole(userId) {
    const [row] = await authDb.select({ role: user.role }).from(user).where(eq(user.id, userId)).limit(1)
    return (row?.role as MemberRole | undefined) ?? null
  },
  async groupIdsOf(userId) {
    const rows = await authDb.select({ id: memberGroupMember.groupId }).from(memberGroupMember).where(eq(memberGroupMember.userId, userId))
    return rows.map((r) => r.id)
  },
  async grantsOn(targets) {
    if (targets.length === 0) return []
    const rows = await authDb
      .select()
      .from(accessGrant)
      .where(or(...targets.map((t) => and(eq(accessGrant.resourceType, t.resourceType), eq(accessGrant.resourceId, t.resourceId)))))
    return rows.map(toGrant)
  },
  async replaceGrants(resourceType, resourceId, grants, grantedBy) {
    await authDb.transaction(async (tx) => {
      await tx.delete(accessGrant).where(and(eq(accessGrant.resourceType, resourceType), eq(accessGrant.resourceId, resourceId)))
      if (grants.length === 0) return
      await tx.insert(accessGrant).values(
        grants.map((g) => ({
          id: randomUUID(),
          resourceType,
          resourceId,
          subjectKind: g.subject.kind,
          subjectUserId: g.subject.kind === 'user' ? g.subject.userId : null,
          subjectGroupId: g.subject.kind === 'group' ? g.subject.groupId : null,
          level: g.level,
          grantedBy,
        })),
      )
    })
  },
  async existingUserIds(ids) {
    if (ids.length === 0) return new Set()
    const rows = await authDb.select({ id: user.id }).from(user).where(inArray(user.id, ids))
    return new Set(rows.map((r) => r.id))
  },
  async existingGroupIds(ids) {
    if (ids.length === 0) return new Set()
    const rows = await authDb.select({ id: memberGroup.id }).from(memberGroup).where(inArray(memberGroup.id, ids))
    return new Set(rows.map((r) => r.id))
  },
}
