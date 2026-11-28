import type { HubSpanV1 } from '../payload'
import type { HubTraceStore, StatsGroup, StatsRow, StoredSpan } from './store'
import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { hubTraceBatches, hubTraceSpans } from '$lib/server/db/traces.schema'

/** HubTraceStore over Postgres (migration 0202; company-level tables of the hub install, no RLS). */

type SpanRow = typeof hubTraceSpans.$inferSelect

const toSpan = (r: SpanRow): StoredSpan => ({
  install_id: r.installId,
  batch_id: r.batchId,
  trace_id: r.traceId,
  span_id: r.spanId,
  parent_id: r.parentId,
  kind: r.kind as HubSpanV1['kind'],
  run_kind: r.runKind as HubSpanV1['run_kind'],
  tool: r.tool,
  log_context: r.logContext,
  model: r.model,
  provider_kind: r.providerKind as HubSpanV1['provider_kind'],
  tokens_in: r.tokensIn,
  tokens_out: r.tokensOut,
  cost_usd: r.costUsd,
  duration_ms: r.durationMs,
  attempt: r.attempt,
  start_offset_ms: r.startOffsetMs,
  outcome: r.outcome as HubSpanV1['outcome'],
  error_code: r.errorCode as HubSpanV1['error_code'],
  audit_class: r.auditClass as HubSpanV1['audit_class'],
  via: r.via as HubSpanV1['via'],
  app_version: r.appVersion,
  ee_version: r.eeVersion,
  day: r.day,
})

/** The grouping column of a stats query: a fixed map, never caller text in SQL. */
const GROUP_COLUMN: Record<StatsGroup, ReturnType<typeof sql.raw>> = {
  tool: sql.raw('tool'),
  model: sql.raw('model'),
  log_context: sql.raw('log_context'),
  app_version: sql.raw('app_version'),
  day: sql.raw('day::text'),
  kind: sql.raw('kind'),
  error_code: sql.raw('error_code'),
}
/** The same in the rollup table, where '' is "none"; a dimension the rollup does not keep has no history there. */
const DAILY_COLUMN: Partial<Record<StatsGroup, ReturnType<typeof sql.raw>>> = {
  tool: sql.raw("NULLIF(tool, '')"),
  model: sql.raw("NULLIF(model, '')"),
  log_context: sql.raw("NULLIF(log_context, '')"),
  app_version: sql.raw('app_version'),
  day: sql.raw('day::text'),
  kind: sql.raw('kind'),
}

type Raw = Record<string, unknown>

export function dbHubTraceStore(db: AppDatabase): HubTraceStore {
  const rows = async (q: ReturnType<typeof sql>): Promise<Raw[]> => {
    const out = (await db.execute(q)) as unknown
    return (Array.isArray(out) ? out : ((out as { rows?: Raw[] }).rows ?? [])) as Raw[]
  }
  return {
    async insertBatch(installId, batchId, spans, at) {
      return db.transaction(async (tx) => {
        const fresh = await tx
          .insert(hubTraceBatches)
          .values({ installId, batchId, spanCount: spans.length, receivedAt: at })
          .onConflictDoNothing()
          .returning({ batchId: hubTraceBatches.batchId })
        if (fresh.length === 0) return 'duplicate' as const
        await tx
          .insert(hubTraceSpans)
          .values(
            spans.map((s) => ({
              installId,
              batchId,
              traceId: s.trace_id,
              spanId: s.span_id,
              parentId: s.parent_id,
              kind: s.kind,
              runKind: s.run_kind,
              tool: s.tool,
              logContext: s.log_context,
              model: s.model,
              providerKind: s.provider_kind,
              tokensIn: s.tokens_in,
              tokensOut: s.tokens_out,
              costUsd: s.cost_usd,
              durationMs: s.duration_ms,
              attempt: s.attempt,
              startOffsetMs: s.start_offset_ms,
              outcome: s.outcome,
              errorCode: s.error_code,
              auditClass: s.audit_class,
              via: s.via,
              appVersion: s.app_version,
              eeVersion: s.ee_version,
              day: s.day,
              receivedAt: at,
            })),
          )
          // A span id seen before from this install (a re-sent row) keeps its first copy.
          .onConflictDoNothing()
        return 'created' as const
      })
    },
    async deleteBatch(installId, batchId) {
      return db.transaction(async (tx) => {
        const gone = await tx
          .delete(hubTraceSpans)
          .where(and(eq(hubTraceSpans.installId, installId), eq(hubTraceSpans.batchId, batchId)))
          .returning({ id: hubTraceSpans.spanId })
        await tx.delete(hubTraceBatches).where(and(eq(hubTraceBatches.installId, installId), eq(hubTraceBatches.batchId, batchId)))
        return gone.length
      })
    },
    async deleteInstall(installId) {
      return db.transaction(async (tx) => {
        const gone = await tx.delete(hubTraceSpans).where(eq(hubTraceSpans.installId, installId)).returning({ id: hubTraceSpans.spanId })
        await tx.delete(hubTraceBatches).where(eq(hubTraceBatches.installId, installId))
        return gone.length
      })
    },
    async listRuns(f) {
      const conds = [isNull(hubTraceSpans.parentId)]
      if (f.outcome) conds.push(eq(hubTraceSpans.outcome, f.outcome))
      if (f.errorCode) conds.push(eq(hubTraceSpans.errorCode, f.errorCode))
      if (f.appVersion) conds.push(eq(hubTraceSpans.appVersion, f.appVersion))
      const out = await db
        .select()
        .from(hubTraceSpans)
        .where(and(...conds))
        .orderBy(desc(hubTraceSpans.day), desc(hubTraceSpans.receivedAt))
        .limit(f.limit)
      return out.map(toSpan)
    },
    async getTrace(installId, traceId) {
      const out = await db
        .select()
        .from(hubTraceSpans)
        .where(and(eq(hubTraceSpans.installId, installId), eq(hubTraceSpans.traceId, traceId)))
        .orderBy(hubTraceSpans.startOffsetMs)
      return out.map(toSpan)
    },
    async stats(f) {
      const col = GROUP_COLUMN[f.groupBy]
      const kind = f.kind ? sql`AND kind = ${f.kind}` : sql``
      const raw = await rows(sql`
        SELECT ${col} AS key, count(*)::int AS spans, count(*) FILTER (WHERE outcome <> 'ok')::int AS errors,
               count(DISTINCT install_id)::int AS installs,
               percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms) AS p50,
               percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms) AS p95,
               coalesce(sum(tokens_in), 0)::bigint AS tokens_in, coalesce(sum(tokens_out), 0)::bigint AS tokens_out,
               coalesce(sum(cost_usd), 0)::float8 AS cost
        FROM hub_trace_spans
        WHERE day BETWEEN ${f.fromDay}::date AND ${f.toDay}::date ${kind}
        GROUP BY 1`)
      // Days older than the raw window: the rollups (no install count or exact percentiles across days).
      const dcol = DAILY_COLUMN[f.groupBy]
      const old = dcol
        ? await rows(sql`
            SELECT ${dcol} AS key, sum(spans)::int AS spans, sum(errors)::int AS errors, max(installs)::int AS installs,
                   NULL AS p50, max(p95_ms) AS p95, sum(tokens_in)::bigint AS tokens_in, sum(tokens_out)::bigint AS tokens_out, sum(cost_usd)::float8 AS cost
            FROM hub_trace_daily
            WHERE day BETWEEN ${f.fromDay}::date AND ${f.toDay}::date ${kind}
              AND day NOT IN (SELECT DISTINCT day FROM hub_trace_spans WHERE day BETWEEN ${f.fromDay}::date AND ${f.toDay}::date)
            GROUP BY 1`)
        : []
      const merged = new Map<string, StatsRow>()
      for (const r of [...raw, ...old]) {
        const key = (r.key as string | null) ?? null
        const k = key ?? '\u0000'
        const prev = merged.get(k)
        const n = (v: unknown) => (v == null ? null : Math.round(Number(v)))
        const row: StatsRow = {
          key,
          spans: Number(r.spans),
          errors: Number(r.errors),
          errorRate: 0,
          installs: Number(r.installs),
          p50Ms: n(r.p50),
          p95Ms: n(r.p95),
          tokensIn: Number(r.tokens_in),
          tokensOut: Number(r.tokens_out),
          costUsd: Number(r.cost),
        }
        if (prev) {
          prev.spans += row.spans
          prev.errors += row.errors
          prev.installs = Math.max(prev.installs, row.installs)
          prev.p95Ms = Math.max(prev.p95Ms ?? 0, row.p95Ms ?? 0) || null
          prev.tokensIn += row.tokensIn
          prev.tokensOut += row.tokensOut
          prev.costUsd += row.costUsd
        } else merged.set(k, row)
      }
      return [...merged.values()]
        .map((r) => ({ ...r, errorRate: r.spans === 0 ? 0 : Math.round((r.errors / r.spans) * 10_000) / 10_000, costUsd: Math.round(r.costUsd * 10_000) / 10_000 }))
        .sort((a, b) => b.spans - a.spans)
    },
    async rollup(beforeDay) {
      const out = await rows(sql`
        INSERT INTO hub_trace_daily (day, kind, tool, model, log_context, app_version, spans, errors, installs, p50_ms, p95_ms, tokens_in, tokens_out, cost_usd)
        SELECT day, kind, coalesce(tool, ''), coalesce(model, ''), coalesce(log_context, ''), app_version,
               count(*), count(*) FILTER (WHERE outcome <> 'ok'), count(DISTINCT install_id),
               round(percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms))::int,
               round(percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms))::int,
               coalesce(sum(tokens_in), 0), coalesce(sum(tokens_out), 0), coalesce(sum(cost_usd), 0)
        FROM hub_trace_spans
        WHERE day < ${beforeDay}::date
        GROUP BY 1, 2, 3, 4, 5, 6
        ON CONFLICT (day, kind, tool, model, log_context, app_version) DO UPDATE SET
          spans = EXCLUDED.spans, errors = EXCLUDED.errors, installs = EXCLUDED.installs, p50_ms = EXCLUDED.p50_ms,
          p95_ms = EXCLUDED.p95_ms, tokens_in = EXCLUDED.tokens_in, tokens_out = EXCLUDED.tokens_out, cost_usd = EXCLUDED.cost_usd
        RETURNING 1`)
      return out.length
    },
    async retention(cutoffDay) {
      const expired = await rows(sql`DELETE FROM hub_trace_spans WHERE day < ${cutoffDay}::date RETURNING 1`)
      const revoked = await rows(sql`
        DELETE FROM hub_trace_spans s USING hub_installs i
        WHERE i.install_id = s.install_id AND i.revoked_at IS NOT NULL RETURNING 1`)
      await rows(sql`DELETE FROM hub_trace_batches b USING hub_installs i WHERE i.install_id = b.install_id AND i.revoked_at IS NOT NULL`)
      return { expired: expired.length, revoked: revoked.length }
    },
  }
}
