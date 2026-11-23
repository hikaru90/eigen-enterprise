import type { CoworkerProfileRow, CoworkerStore, OrgPositionRow } from './service'
import { and, asc, eq, isNull, sql } from 'drizzle-orm'
import { authDb } from '$lib/server/db/auth-db'
import { user } from '$lib/server/db/auth.schema'
import { coworkerProfile, orgPosition } from '$lib/server/db/coworkers.schema'

/**
 * The co-workers and the org chart in Postgres (migration 0170). Users live in
 * the Better Auth table, so this runs on the auth pool (the app's RLS role may
 * only read `user`); org_position and coworker_profile are company-level tables
 * without RLS. Every write runs in one transaction that first locks
 * org_position, so a cycle check never races another org write.
 */

type Db = Pick<typeof authDb, 'select' | 'insert' | 'update' | 'execute'>

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

const positionOf = (r: typeof orgPosition.$inferSelect): OrgPositionRow => ({
  userId: r.userId,
  title: r.title,
  reportsToUserId: r.reportsToUserId,
  accountabilities: r.accountabilities,
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy,
})

function storeOver(db: Db, inTransaction: boolean): CoworkerStore {
  const store: CoworkerStore = {
    async listMembers() {
      return db
        .select({ id: user.id, name: user.name, email: user.email, role: user.role, kind: user.kind, createdAt: user.createdAt })
        .from(user)
        .leftJoin(coworkerProfile, eq(coworkerProfile.userId, user.id))
        .where(and(eq(user.accountKind, 'production'), isNull(coworkerProfile.removedAt)))
        .orderBy(asc(user.createdAt))
    },
    async listPositions() {
      return (await db.select().from(orgPosition)).map(positionOf)
    },
    async listProfiles() {
      return (await db.select().from(coworkerProfile).orderBy(asc(coworkerProfile.createdAt))).map(profileOf)
    },
    async coworkerUser(userId) {
      const [row] = await db
        .select({ id: user.id, name: user.name, email: user.email })
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
      await db.insert(orgPosition).values(position)
    },
    async updateCoworker(userId, patch) {
      if (patch.name !== undefined) {
        const rows = await db
          .update(user)
          .set({ name: patch.name })
          .where(and(eq(user.id, userId), eq(user.kind, 'coworker')))
          .returning({ id: user.id })
        if (rows.length !== 1) throw new Error(`renaming co-worker ${userId} matched ${rows.length} rows`)
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
      const { userId, ...rest } = row
      await db.insert(orgPosition).values(row).onConflictDoUpdate({ target: orgPosition.userId, set: rest })
      void userId
    },
    async markRemoved(userId, at, by, reparentTo) {
      const rows = await db
        .update(coworkerProfile)
        .set({ enabled: false, removedAt: at, removedBy: by, updatedAt: at })
        .where(and(eq(coworkerProfile.userId, userId), isNull(coworkerProfile.removedAt)))
        .returning({ id: coworkerProfile.userId })
      if (rows.length !== 1) throw new Error(`removing co-worker ${userId} matched ${rows.length} rows`)
      await db
        .update(orgPosition)
        .set({ reportsToUserId: reparentTo, updatedAt: at, updatedBy: by })
        .where(eq(orgPosition.reportsToUserId, userId))
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
