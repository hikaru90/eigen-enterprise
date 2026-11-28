import type { HubSpanV1 } from '../payload'

/** The makers' hub store (migration 0202, plan/traces-phone-home.md T3). */

export type StoredSpan = HubSpanV1 & { install_id: string; batch_id: string }

export const STATS_GROUPS = ['tool', 'model', 'log_context', 'app_version', 'day', 'kind', 'error_code'] as const
export type StatsGroup = (typeof STATS_GROUPS)[number]

export type StatsFilter = { groupBy: StatsGroup; kind: HubSpanV1['kind'] | null; fromDay: string; toDay: string }
export type StatsRow = { key: string | null; spans: number; errors: number; errorRate: number; installs: number; p50Ms: number | null; p95Ms: number | null; tokensIn: number; tokensOut: number; costUsd: number }

export type RunsFilter = { outcome: HubSpanV1['outcome'] | null; errorCode: string | null; appVersion: string | null; limit: number }

export type HubTraceStore = {
  /** Idempotent by (install, batch): a batch received again is `duplicate` and changes nothing. */
  insertBatch(installId: string, batchId: string, spans: readonly HubSpanV1[], at: Date): Promise<'created' | 'duplicate'>
  deleteBatch(installId: string, batchId: string): Promise<number>
  deleteInstall(installId: string): Promise<number>
  /** Root spans (runs, jobs, upgrades, lone calls), newest first. */
  listRuns(filter: RunsFilter): Promise<StoredSpan[]>
  getTrace(installId: string, traceId: string): Promise<StoredSpan[]>
  /** Raw spans in [fromDay, toDay] grouped; days before the raw window come from the rollups. */
  stats(filter: StatsFilter): Promise<StatsRow[]>
  /** Daily rollups for every day before `beforeDay` that has raw spans (recomputed, idempotent). */
  rollup(beforeDay: string): Promise<number>
  /** Raw spans of days before `cutoffDay` go (their rollups stay); spans of revoked installs go now. */
  retention(cutoffDay: string): Promise<{ expired: number; revoked: number }>
}
