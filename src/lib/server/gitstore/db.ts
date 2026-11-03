import type { WatermarkStore } from './framework'
import type { GroupEntity, GroupIndex } from './surfaces/groups'
import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { gitstoreWatermark } from '$lib/server/db/gitstore.schema'
import { memberGroup, memberGroupMember } from '$lib/server/db/team.schema'

/** Watermarks in Postgres (gitstore_watermark, migration 0113). */
export const dbWatermarks: WatermarkStore = {
  async get(surface) {
    const rows = await authDb
      .select({ commit: gitstoreWatermark.commit })
      .from(gitstoreWatermark)
      .where(eq(gitstoreWatermark.surface, surface))
      .limit(1)
    return rows[0]?.commit ?? null
  },
  async set(surface, commit) {
    await authDb
      .insert(gitstoreWatermark)
      .values({ surface, commit })
      .onConflictDoUpdate({
        target: gitstoreWatermark.surface,
        set: { commit, updatedAt: new Date() },
      })
  },
}

type Tx = Parameters<Parameters<typeof authDb.transaction>[0]>[0]

async function knownUsers(tx: Tx, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await tx.select({ id: user.id }).from(user).where(inArray(user.id, ids))
  return new Set(rows.map((r) => r.id))
}

/** Member order is the file's list order, kept through added_at (createdAt + i ms). */
async function writeGroup(tx: Tx, g: GroupEntity, known: Set<string>): Promise<string[]> {
  const problems = g.memberIds
    .filter((m) => !known.has(m))
    .map((m) => `group ${g.name}: no such user ${m} — membership skipped`)
  const members = g.memberIds.filter((m) => known.has(m))
  await tx
    .insert(memberGroup)
    .values({
      id: g.id,
      name: g.name,
      description: g.description,
      createdBy: g.createdBy,
      createdAt: g.createdAt,
      updatedAt: g.createdAt,
    })
    .onConflictDoUpdate({
      target: memberGroup.id,
      set: {
        name: g.name,
        description: g.description,
        createdBy: g.createdBy,
        createdAt: g.createdAt,
        updatedAt: new Date(),
      },
    })
  await tx.delete(memberGroupMember).where(eq(memberGroupMember.groupId, g.id))
  if (members.length) {
    await tx
      .insert(memberGroupMember)
      .values(
        members.map((userId, i) => ({
          groupId: g.id,
          userId,
          addedAt: new Date(g.createdAt.getTime() + i),
        })),
      )
  }
  return problems
}

/** member_group + member_group_member as the groups index. */
export const dbGroupIndex: GroupIndex = {
  async all() {
    const groups = await authDb.select().from(memberGroup).orderBy(asc(memberGroup.id))
    const links = await authDb
      .select()
      .from(memberGroupMember)
      .orderBy(asc(memberGroupMember.addedAt), asc(memberGroupMember.userId))
    return groups.map((g) => ({
      id: g.id,
      name: g.name,
      description: g.description,
      createdBy: g.createdBy,
      createdAt: g.createdAt,
      memberIds: links.filter((l) => l.groupId === g.id).map((l) => l.userId),
    }))
  },
  async get(id) {
    const [g] = await authDb.select().from(memberGroup).where(eq(memberGroup.id, id)).limit(1)
    if (!g) return null
    const links = await authDb
      .select({ userId: memberGroupMember.userId })
      .from(memberGroupMember)
      .where(eq(memberGroupMember.groupId, id))
      .orderBy(asc(memberGroupMember.addedAt), asc(memberGroupMember.userId))
    return {
      id: g.id,
      name: g.name,
      description: g.description,
      createdBy: g.createdBy,
      createdAt: g.createdAt,
      memberIds: links.map((l) => l.userId),
    }
  },
  async upsert(g) {
    return authDb.transaction(async (tx) => ({
      problems: await writeGroup(tx, g, await knownUsers(tx, g.memberIds)),
    }))
  },
  async remove(id) {
    await authDb.delete(memberGroup).where(eq(memberGroup.id, id))
  },
  async replaceAll(groups) {
    return authDb.transaction(async (tx) => {
      const ids = groups.map((g) => g.id)
      // free names first so a swap of names between two groups cannot collide on the unique index
      if (ids.length) await tx.delete(memberGroup).where(notInArray(memberGroup.id, ids))
      else await tx.delete(memberGroup)
      if (ids.length)
        await tx
          .update(memberGroup)
          .set({ name: sql`'~rebuild~' || ${memberGroup.id}` })
          .where(and(inArray(memberGroup.id, ids)))
      const known = await knownUsers(tx, [...new Set(groups.flatMap((g) => g.memberIds))])
      const problems: string[] = []
      for (const g of groups) problems.push(...(await writeGroup(tx, g, known)))
      return { problems }
    })
  },
}
