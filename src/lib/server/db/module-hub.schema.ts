import type { ModuleManifestV1 } from '../../../../contracts/module-manifest'
import type { ModuleReceiptV1 } from '../../../../contracts/module-receipt'
import type { ModuleRunState } from '../../../../contracts/module-workload'
import type { HubFileDto, ModuleSummaryDto } from '../../../../modules/module-hub/types'
import { index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'

/**
 * The module hub (migration 0180, plan/phase-upgrades-u2.md §7): every module
 * version installs published, used only where the module-hub module is active
 * (the central box). Company-level tables, no RLS. `install_id` is the
 * contribute hub's random install id; there is deliberately no foreign key, so
 * an install withdrawing its proposals never erases published (Apache-2.0)
 * code that receipts and restores rely on.
 */

export const hubModules = pgTable(
  'hub_modules',
  {
    installId: uuid('install_id').notNull(),
    moduleId: text('module_id').notNull(),
    name: text('name').notNull(),
    latestBundleSha256: text('latest_bundle_sha256')
      .notNull()
      .references(() => hubModuleVersions.bundleSha256),
    firstPublishedAt: timestamp('first_published_at', { withTimezone: true }).notNull(),
    lastPublishedAt: timestamp('last_published_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.installId, t.moduleId], name: 'hub_modules_pk' }), index('hub_modules_last_published_idx').on(t.lastPublishedAt)],
)

export const hubModuleVersions = pgTable(
  'hub_module_versions',
  {
    bundleSha256: text('bundle_sha256').primaryKey(),
    installId: uuid('install_id').notNull(),
    moduleId: text('module_id').notNull(),
    version: text('version').notNull(),
    commit: text('commit').notNull(),
    manifest: jsonb('manifest').$type<ModuleManifestV1>().notNull(),
    coreApi: text('core_api').notNull(),
    uses: jsonb('uses').$type<ModuleManifestV1['uses']>().notNull(),
    provides: jsonb('provides').$type<ModuleManifestV1['provides']>().notNull(),
    permissions: jsonb('permissions').$type<ModuleManifestV1['permissions']>().notNull(),
    files: jsonb('files').$type<HubFileDto[]>().notNull(),
    bytes: integer('bytes').notNull(),
    deprecatedUses: jsonb('deprecated_uses').$type<string[]>().notNull(),
    receipt: jsonb('receipt').$type<ModuleReceiptV1>().notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull(),
    summary: jsonb('summary').$type<ModuleSummaryDto>(),
    summaryAt: timestamp('summary_at', { withTimezone: true }),
  },
  (t) => [
    unique('hub_module_versions_commit_uq').on(t.installId, t.moduleId, t.commit),
    index('hub_module_versions_module_idx').on(t.installId, t.moduleId, t.publishedAt),
  ],
)

export const hubModuleRuns = pgTable(
  'hub_module_runs',
  {
    installId: uuid('install_id').notNull(),
    moduleId: text('module_id').notNull(),
    bundleSha256: text('bundle_sha256')
      .notNull()
      .references(() => hubModuleVersions.bundleSha256),
    state: text('state').$type<ModuleRunState>().notNull(),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull(),
  },
  (t) => [primaryKey({ columns: [t.installId, t.moduleId], name: 'hub_module_runs_pk' }), index('hub_module_runs_bundle_idx').on(t.bundleSha256)],
)
