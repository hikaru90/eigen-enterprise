import type { HubContribution, HubInstall, HubStore } from './store'
import { and, desc, eq, inArray, isNull, lt, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { hubContributions, hubInstalls, hubRequestCounts, hubSeenSignatures } from '$lib/server/db/contribute.schema'
import { sameContribution } from './memory-store'

/** HubStore over Postgres (migration 0137; company-level tables, no RLS — used only where the hub is active). */
export function dbHubStore(db: AppDatabase): HubStore {
  return {
    async getInstall(installId) {
      const [row] = await db.select().from(hubInstalls).where(eq(hubInstalls.installId, installId)).limit(1)
      return (row as HubInstall | undefined) ?? null
    },
    async insertInstall({ installId, publicKey, appVersion, at }) {
      const out = await db
        .insert(hubInstalls)
        .values({ installId, publicKey, appVersion, registeredAt: at, lastSeenAt: at })
        .onConflictDoNothing({ target: hubInstalls.installId })
        .returning({ id: hubInstalls.installId })
      return out.length === 1
    },
    async touchInstall(installId, at, appVersion) {
      const out = await db
        .update(hubInstalls)
        .set(appVersion === undefined ? { lastSeenAt: at } : { lastSeenAt: at, appVersion })
        .where(eq(hubInstalls.installId, installId))
        .returning({ id: hubInstalls.installId })
      if (out.length === 0) throw new Error(`hub install ${installId} not found`)
    },
    async revokeInstall(installId, at) {
      await db
        .update(hubInstalls)
        .set({ revokedAt: at })
        .where(and(eq(hubInstalls.installId, installId), isNull(hubInstalls.revokedAt)))
      const [row] = await db.select().from(hubInstalls).where(eq(hubInstalls.installId, installId)).limit(1)
      return (row as HubInstall | undefined) ?? null
    },
    async deleteInstall(installId) {
      // hub_contributions cascade with their install.
      const out = await db.delete(hubInstalls).where(eq(hubInstalls.installId, installId)).returning({ id: hubInstalls.installId })
      return out.length === 1
    },
    async upsert(row, at) {
      return db.transaction(async (tx) => {
        const [old] = await tx
          .select()
          .from(hubContributions)
          .where(and(eq(hubContributions.installId, row.installId), eq(hubContributions.remoteId, row.remoteId)))
          .for('update')
        if (!old) {
          const created = await tx
            .insert(hubContributions)
            .values({ ...row, updatedAt: at, receivedAt: at })
            .onConflictDoNothing()
            .returning({ id: hubContributions.remoteId })
          if (created.length === 1) return 'created' as const
          // Inserted concurrently by another request of the same install: compare against that row.
          const [now] = await tx
            .select()
            .from(hubContributions)
            .where(and(eq(hubContributions.installId, row.installId), eq(hubContributions.remoteId, row.remoteId)))
            .for('update')
          if (!now) throw new Error(`hub contribution ${row.installId}/${row.remoteId} vanished during upsert`)
          if (sameContribution(now as HubContribution, row)) return 'unchanged' as const
        } else if (sameContribution(old as HubContribution, row)) {
          return 'unchanged' as const
        }
        const { installId, remoteId, ...fields } = row
        await tx
          .update(hubContributions)
          .set({ ...fields, updatedAt: at })
          .where(and(eq(hubContributions.installId, installId), eq(hubContributions.remoteId, remoteId)))
        return 'updated' as const
      })
    },
    async deleteContribution(installId, remoteId) {
      const out = await db
        .delete(hubContributions)
        .where(and(eq(hubContributions.installId, installId), eq(hubContributions.remoteId, remoteId)))
        .returning({ id: hubContributions.remoteId })
      return out.length === 1
    },
    async get(installId, remoteId) {
      const [row] = await db
        .select()
        .from(hubContributions)
        .where(and(eq(hubContributions.installId, installId), eq(hubContributions.remoteId, remoteId)))
        .limit(1)
      return (row as HubContribution | undefined) ?? null
    },
    async list(statuses) {
      if (statuses.length === 0) return []
      const rows = await db
        .select()
        .from(hubContributions)
        .where(inArray(hubContributions.status, [...statuses]))
        .orderBy(desc(hubContributions.score), desc(hubContributions.updatedAt))
      return rows as HubContribution[]
    },
    async claimSignature(hash, at, pruneBefore) {
      await db.delete(hubSeenSignatures).where(lt(hubSeenSignatures.seenAt, pruneBefore))
      const out = await db
        .insert(hubSeenSignatures)
        .values({ signatureHash: hash, seenAt: at })
        .onConflictDoNothing({ target: hubSeenSignatures.signatureHash })
        .returning({ hash: hubSeenSignatures.signatureHash })
      return out.length === 1
    },
    async countRequest(installId, hour) {
      await db.delete(hubRequestCounts).where(lt(hubRequestCounts.hour, hour))
      const [out] = await db
        .insert(hubRequestCounts)
        .values({ installId, hour, count: 1 })
        .onConflictDoUpdate({
          target: [hubRequestCounts.installId, hubRequestCounts.hour],
          set: { count: sql`${hubRequestCounts.count} + 1` },
        })
        .returning({ count: hubRequestCounts.count })
      if (!out) throw new Error(`hub request count for ${installId} not written`)
      return out.count
    },
  }
}
