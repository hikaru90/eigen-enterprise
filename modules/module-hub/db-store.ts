import type { HubModuleRow, HubModuleVersion, ModuleHubStore } from './store'
import { and, desc, eq, ilike, isNull, or, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { hubInstalls } from '$lib/server/db/contribute.schema'
import { hubModuleRuns, hubModules, hubModuleVersions } from '$lib/server/db/module-hub.schema'

/** ModuleHubStore over Postgres (migration 0180; company-level tables, no RLS — used only where the module hub is active). */

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)

export function dbModuleHubStore(db: AppDatabase): ModuleHubStore {
  const rowSelect = {
    installId: hubModules.installId,
    moduleId: hubModules.moduleId,
    name: hubModules.name,
    latestBundleSha256: hubModules.latestBundleSha256,
    firstPublishedAt: hubModules.firstPublishedAt,
    lastPublishedAt: hubModules.lastPublishedAt,
    description: sql<string>`${hubModuleVersions.manifest} ->> 'description'`,
    latestVersion: hubModuleVersions.version,
    versions: sql<number>`(select count(*)::int from ${hubModuleVersions} v where v.install_id = ${hubModules.installId} and v.module_id = ${hubModules.moduleId})`,
  }
  const moduleRows = () =>
    db.select(rowSelect).from(hubModules).innerJoin(hubModuleVersions, eq(hubModuleVersions.bundleSha256, hubModules.latestBundleSha256))
  return {
    async getVersion(sha) {
      const [row] = await db.select().from(hubModuleVersions).where(eq(hubModuleVersions.bundleSha256, sha)).limit(1)
      return (row as HubModuleVersion | undefined) ?? null
    },
    async versionByCommit(installId, moduleId, commit) {
      const [row] = await db
        .select()
        .from(hubModuleVersions)
        .where(and(eq(hubModuleVersions.installId, installId), eq(hubModuleVersions.moduleId, moduleId), eq(hubModuleVersions.commit, commit)))
        .limit(1)
      return (row as HubModuleVersion | undefined) ?? null
    },
    async insertVersion(v) {
      return db.transaction(async (tx) => {
        const out = await tx.insert(hubModuleVersions).values(v).onConflictDoNothing().returning({ sha: hubModuleVersions.bundleSha256 })
        if (out.length !== 1) return false
        await tx
          .insert(hubModules)
          .values({
            installId: v.installId,
            moduleId: v.moduleId,
            name: v.manifest.name,
            latestBundleSha256: v.bundleSha256,
            firstPublishedAt: v.publishedAt,
            lastPublishedAt: v.publishedAt,
          })
          .onConflictDoUpdate({
            target: [hubModules.installId, hubModules.moduleId],
            set: { name: v.manifest.name, latestBundleSha256: v.bundleSha256, lastPublishedAt: v.publishedAt },
          })
        return true
      })
    },
    async setSummary(sha, summary, at) {
      const out = await db
        .update(hubModuleVersions)
        .set({ summary, summaryAt: at })
        .where(eq(hubModuleVersions.bundleSha256, sha))
        .returning({ sha: hubModuleVersions.bundleSha256 })
      if (out.length !== 1) throw new Error(`no module version ${sha}`)
    },
    async listModules({ query, offset, limit }) {
      const q = query?.trim()
      const match = q ? or(ilike(hubModules.moduleId, `%${escapeLike(q)}%`), ilike(hubModules.name, `%${escapeLike(q)}%`)) : undefined
      const rows = await moduleRows()
        .innerJoin(hubInstalls, eq(hubInstalls.installId, hubModules.installId))
        .where(and(isNull(hubInstalls.revokedAt), match))
        .orderBy(desc(hubModules.lastPublishedAt), hubModules.installId, hubModules.moduleId)
        .offset(offset)
        .limit(limit)
      return rows as HubModuleRow[]
    },
    async getModule(installId, moduleId) {
      const [row] = await moduleRows()
        .where(and(eq(hubModules.installId, installId), eq(hubModules.moduleId, moduleId)))
        .limit(1)
      return (row as HubModuleRow | undefined) ?? null
    },
    async versions(installId, moduleId) {
      const rows = await db
        .select()
        .from(hubModuleVersions)
        .where(and(eq(hubModuleVersions.installId, installId), eq(hubModuleVersions.moduleId, moduleId)))
        .orderBy(desc(hubModuleVersions.publishedAt), desc(hubModuleVersions.bundleSha256))
      return rows as HubModuleVersion[]
    },
    async reportRun(run) {
      await db
        .insert(hubModuleRuns)
        .values(run)
        .onConflictDoUpdate({
          target: [hubModuleRuns.installId, hubModuleRuns.moduleId],
          set: { bundleSha256: run.bundleSha256, state: run.state, reportedAt: run.reportedAt },
        })
    },
    async runs(installId, moduleId) {
      const rows = await db
        .select({
          installId: hubModuleRuns.installId,
          moduleId: hubModuleRuns.moduleId,
          bundleSha256: hubModuleRuns.bundleSha256,
          state: hubModuleRuns.state,
          reportedAt: hubModuleRuns.reportedAt,
          version: hubModuleVersions.version,
        })
        .from(hubModuleRuns)
        .innerJoin(hubModuleVersions, eq(hubModuleVersions.bundleSha256, hubModuleRuns.bundleSha256))
        .where(and(eq(hubModuleVersions.installId, installId), eq(hubModuleVersions.moduleId, moduleId)))
        .orderBy(desc(hubModuleRuns.reportedAt))
      return rows
    },
  }
}
