import type { CoworkerProfileRow, CoworkerStore, OrgPositionRow } from './service'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { coworkerProfile, orgPosition, orgPositionReport } from '$lib/server/db/coworkers.schema'

/**
 * The co-workers and the org chart in Postgres (migration 0170, 0182). Users live in
 * the Better Auth table, so this runs on the auth pool (the app's RLS role may
 * only read `user`); org_position, org_position_report and coworker_profile are
 * company-level tables without RLS. Every write runs in one transaction that
 * first locks org_position, so a cycle check never races another org write.
 */

type Db = Pick<typeof authDb, 'select' | 'insert' | 'update' | 'delete' | 'execute'>

const profileOf = (r: typeof coworkerProfile.$inferSelect): CoworkerProfileRow => ({
  userId: r.userId,
  slug: r.slug,
  lens: r.lens,
  modelId: r.modelId,
  enabled: r.enabled,
  dailyCapUsd: Number(r.dailyCapUsd),
  templateId: r.templateId,
  createdBy: r.createdBy,
  createdAt: r.createdAt,
  updatedAt: r.updatedAt,
  removedAt: r.removedAt,
  removedBy: r.removedBy,
})

function dedupeManagers(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

async function syncPositionReports(db: Db, userId: string, reportsToUserIds: readonly string[]): Promise<void> {
  await db.delete(orgPositionReport).where(eq(orgPositionReport.userId, userId))
  if (reportsToUserIds.length > 0) {
    await db.insert(orgPositionReport).values(
      reportsToUserIds.map((reportsToUserId, position) => ({ userId, reportsToUserId, position })),
    )
  }
}

function storeOver(db: Db, inTransaction: boolean): CoworkerStore {
  const store: CoworkerStore = {
    async listMembers() {
      return db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          kind: user.kind,
          createdAt: user.createdAt,
          image: user.image,
          avatarSha256: user.avatarSha256,
        })
        .from(user)
        .leftJoin(coworkerProfile, eq(coworkerProfile.userId, user.id))
        .where(and(eq(user.accountKind, 'production'), isNull(coworkerProfile.removedAt)))
        .orderBy(asc(user.createdAt))
    },
    async listPositions() {
      const [positions, edges] = await Promise.all([
        db.select().from(orgPosition),
        db.select().from(orgPositionReport).orderBy(asc(orgPositionReport.userId), asc(orgPositionReport.position)),
      ])
      const byUser = new Map<string, string[]>()
      for (const e of edges) {
        const list = byUser.get(e.userId)
        if (list) list.push(e.reportsToUserId)
        else byUser.set(e.userId, [e.reportsToUserId])
      }
      return positions.map((r): OrgPositionRow => {
        const reportsToUserIds = byUser.get(r.userId) ?? (r.reportsToUserId ? [r.reportsToUserId] : [])
        return {
          userId: r.userId,
          title: r.title,
          reportsToUserId: reportsToUserIds[0] ?? null,
          reportsToUserIds,
          accountabilities: r.accountabilities,
          updatedAt: r.updatedAt,
          updatedBy: r.updatedBy,
        }
      })
    },
    async listProfiles() {
      return (await db.select().from(coworkerProfile).orderBy(asc(coworkerProfile.createdAt))).map(profileOf)
    },
    async coworkerUser(userId) {
      const [row] = await db
        .select({
          id: user.id,
          name: user.name,
          email: user.email,
          image: user.image,
          avatarSha256: user.avatarSha256,
        })
        .from(user)
        .where(and(eq(user.id, userId), eq(user.kind, 'coworker')))
        .limit(1)
      return row ?? null
    },
    async slugTaken(slug) {
      const [row] = await db.select({ id: coworkerProfile.userId }).from(coworkerProfile).where(eq(coworkerProfile.slug, slug)).limit(1)
      return Boolean(row)
    },
    async insertCoworker({ user: u, profile, position }) {
      await db.insert(user).values({
        id: u.id,
        name: u.name,
        email: u.email,
        image: u.image,
        avatarSha256: u.avatarSha256,
        // Never verified, never signed in: no account row, and auth refuses its session.
        emailVerified: false,
        onboardingCompleted: true,
        role: 'member',
        kind: 'coworker',
        accountKind: 'production',
        createdAt: u.createdAt,
        updatedAt: u.createdAt,
      })
      await db.insert(coworkerProfile).values({ ...profile, dailyCapUsd: String(profile.dailyCapUsd) })
      const reportsToUserIds = dedupeManagers(position.reportsToUserIds)
      await db.insert(orgPosition).values({
        userId: position.userId,
        title: position.title,
        reportsToUserId: reportsToUserIds[0] ?? null,
        accountabilities: position.accountabilities,
        updatedAt: position.updatedAt,
        updatedBy: position.updatedBy,
      })
      await syncPositionReports(db, position.userId, reportsToUserIds)
    },
    async updateCoworker(userId, patch) {
      if (patch.name !== undefined || patch.avatar !== undefined) {
        const userSet: { name?: string; image?: string | null; avatarSha256?: string | null } = {}
        if (patch.name !== undefined) userSet.name = patch.name
        if (patch.avatar !== undefined) {
          userSet.image = patch.avatar.image
          userSet.avatarSha256 = patch.avatar.avatarSha256
        }
        const rows = await db
          .update(user)
          .set(userSet)
          .where(and(eq(user.id, userId), eq(user.kind, 'coworker')))
          .returning({ id: user.id })
        if (rows.length !== 1) throw new Error(`updating co-worker user ${userId} matched ${rows.length} rows`)
      }
      if (patch.profile) {
        const { dailyCapUsd, ...rest } = patch.profile
        const rows = await db
          .update(coworkerProfile)
          .set({ ...rest, ...(dailyCapUsd === undefined ? {} : { dailyCapUsd: String(dailyCapUsd) }) })
          .where(and(eq(coworkerProfile.userId, userId), isNull(coworkerProfile.removedAt)))
          .returning({ id: coworkerProfile.userId })
        if (rows.length !== 1) throw new Error(`updating co-worker ${userId} matched ${rows.length} rows`)
      }
      if (patch.position) await store.upsertPosition(patch.position)
    },
    async upsertPosition(row) {
      const reportsToUserIds = dedupeManagers(row.reportsToUserIds)
      const primary = reportsToUserIds[0] ?? null
      const values = {
        userId: row.userId,
        title: row.title,
        reportsToUserId: primary,
        accountabilities: row.accountabilities,
        updatedAt: row.updatedAt,
        updatedBy: row.updatedBy,
      }
      await db.insert(orgPosition).values(values).onConflictDoUpdate({
        target: orgPosition.userId,
        set: {
          title: row.title,
          reportsToUserId: primary,
          accountabilities: row.accountabilities,
          updatedAt: row.updatedAt,
          updatedBy: row.updatedBy,
        },
      })
      await syncPositionReports(db, row.userId, reportsToUserIds)
    },
    async markRemoved(userId, at, by, reparentTo) {
      const rows = await db
        .update(coworkerProfile)
        .set({ enabled: false, removedAt: at, removedBy: by, updatedAt: at })
        .where(and(eq(coworkerProfile.userId, userId), isNull(coworkerProfile.removedAt)))
        .returning({ id: coworkerProfile.userId })
      if (rows.length !== 1) throw new Error(`removing co-worker ${userId} matched ${rows.length} rows`)

      const [edgeSubs, legacySubs] = await Promise.all([
        db.select({ userId: orgPositionReport.userId }).from(orgPositionReport).where(eq(orgPositionReport.reportsToUserId, userId)),
        db.select({ userId: orgPosition.userId }).from(orgPosition).where(eq(orgPosition.reportsToUserId, userId)),
      ])
      const subIds = new Set([...edgeSubs.map((r) => r.userId), ...legacySubs.map((r) => r.userId)])
      if (subIds.size > 0) {
        const positions = new Map((await store.listPositions()).map((p) => [p.userId, p]))
        for (const subId of subIds) {
          const current = positions.get(subId)?.reportsToUserIds ?? []
          const replaced = dedupeManagers(
            current.flatMap((id) => (id === userId ? reparentTo : [id])).filter((id) => id !== subId),
          )
          await db
            .update(orgPosition)
            .set({ reportsToUserId: replaced[0] ?? null, updatedAt: at, updatedBy: by })
            .where(eq(orgPosition.userId, subId))
          await syncPositionReports(db, subId, replaced)
        }
      }
    },
    async transaction(fn) {
      if (inTransaction) return fn(store)
      return authDb.transaction(async (tx) => {
        await tx.execute(sql`LOCK TABLE org_position IN SHARE ROW EXCLUSIVE MODE`)
        return fn(storeOver(tx, true))
      })
    },
  }
  return store
}

export const dbCoworkerStore: CoworkerStore = storeOver(authDb, false)
