import { and, asc, eq, inArray, sql } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { memberGroup, memberGroupMember } from '$lib/server/db/team.schema'
import type { Group, GroupStore } from './groups'

async function withMembers(rows: Array<typeof memberGroup.$inferSelect>): Promise<Group[]> {
  if (rows.length === 0) return []
  const links = await authDb
    .select({ groupId: memberGroupMember.groupId, userId: memberGroupMember.userId })
    .from(memberGroupMember)
    .where(inArray(memberGroupMember.groupId, rows.map((r) => r.id)))
    .orderBy(asc(memberGroupMember.addedAt))
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description,
    createdAt: r.createdAt,
    memberIds: links.filter((l) => l.groupId === r.id).map((l) => l.userId),
  }))
}

/** Groups over Postgres (member_group + member_group_member, migration 0107). */
export const dbGroupStore: GroupStore = {
  async listGroups() {
    return withMembers(await authDb.select().from(memberGroup).orderBy(asc(sql`lower(${memberGroup.name})`)))
  },
  async getGroup(id) {
    return (await withMembers(await authDb.select().from(memberGroup).where(eq(memberGroup.id, id)).limit(1)))[0] ?? null
  },
  async findGroupByName(name) {
    const rows = await authDb.select().from(memberGroup).where(eq(sql`lower(${memberGroup.name})`, name.toLowerCase())).limit(1)
    return (await withMembers(rows))[0] ?? null
  },
  async insertGroup(g) {
    await authDb.transaction(async (tx) => {
      await tx.insert(memberGroup).values({ id: g.id, name: g.name, description: g.description, createdBy: g.createdBy })
      if (g.memberIds.length) await tx.insert(memberGroupMember).values(g.memberIds.map((userId) => ({ groupId: g.id, userId })))
    })
  },
  async updateGroup(id, patch) {
    await authDb.update(memberGroup).set({ ...patch, updatedAt: new Date() }).where(eq(memberGroup.id, id))
  },
  async setGroupMembers(id, ids) {
    await authDb.transaction(async (tx) => {
      const current = await tx.select({ userId: memberGroupMember.userId }).from(memberGroupMember).where(eq(memberGroupMember.groupId, id))
      const have = new Set(current.map((c) => c.userId))
      const drop = [...have].filter((u) => !ids.includes(u))
      const add = ids.filter((u) => !have.has(u))
      if (drop.length) await tx.delete(memberGroupMember).where(and(eq(memberGroupMember.groupId, id), inArray(memberGroupMember.userId, drop)))
      if (add.length) await tx.insert(memberGroupMember).values(add.map((userId) => ({ groupId: id, userId })))
      await tx.update(memberGroup).set({ updatedAt: new Date() }).where(eq(memberGroup.id, id))
    })
  },
  async deleteGroup(id) {
    await authDb.delete(memberGroup).where(eq(memberGroup.id, id))
  },
  async existingMemberIds(ids) {
    if (ids.length === 0) return new Set()
    const rows = await authDb
      .select({ id: user.id })
      .from(user)
      .where(and(inArray(user.id, ids), eq(user.accountKind, 'production')))
    return new Set(rows.map((r) => r.id))
  },
}
