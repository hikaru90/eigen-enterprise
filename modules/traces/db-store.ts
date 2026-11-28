import type { TraceValueChoice } from './decision-kinds'
import type { TraceSourceRow, Withheld } from './payload'
import type { BatchState, TraceBatch, TraceCursor, TraceSource, TraceSourceReader, TraceStore } from './store'
import { randomBytes } from 'node:crypto'
import { and, asc, desc, eq, inArray, lte, sql } from 'drizzle-orm'
import type { AppDatabase } from '$lib/server/db/context'
import { traceBatch, traceExportCursor, traceShareSettings, traceValueVerdict } from '$lib/server/db/traces.schema'
import { valueKey, type VerdictCache } from './value-kind'

/** TraceStore over Postgres (migration 0201; company-level tables, no RLS). */

type BatchRow = typeof traceBatch.$inferSelect

const toBatch = (r: BatchRow): TraceBatch => ({
  id: r.id,
  state: r.state as BatchState,
  spanCount: r.spanCount,
  body: r.body,
  withheld: r.withheld as Withheld[],
  attempts: r.attempts,
  nextAttemptAt: r.nextAttemptAt,
  lastError: r.lastError,
  createdAt: r.createdAt,
  sentAt: r.sentAt,
  withdrawnAt: r.withdrawnAt,
})

function dbVerdictCache(db: AppDatabase): VerdictCache {
  return {
    async get(values) {
      const out = new Map<string, TraceValueChoice>()
      if (values.length === 0) return out
      const rows = await db
        .select()
        .from(traceValueVerdict)
        .where(inArray(traceValueVerdict.value, [...new Set(values.map((v) => v.value))]))
      const wanted = new Set(values.map(valueKey))
      for (const r of rows) {
        const k = valueKey({ field: r.field as never, value: r.value })
        if (wanted.has(k)) out.set(k, r.verdict)
      }
      return out
    },
    async put(v, verdict, at) {
      await db
        .insert(traceValueVerdict)
        .values({ field: v.field, value: v.value, verdict, decidedAt: at })
        .onConflictDoUpdate({ target: [traceValueVerdict.field, traceValueVerdict.value], set: { verdict, decidedAt: at } })
    },
  }
}

export function dbTraceStore(db: AppDatabase): TraceStore {
  const setSettings = async (patch: Partial<typeof traceShareSettings.$inferInsert>) => {
    const out = await db.update(traceShareSettings).set(patch).where(eq(traceShareSettings.id, 1)).returning({ id: traceShareSettings.id })
    if (out.length === 0) throw new Error('trace_share_settings has no row (settings() makes it)')
  }
  const store: TraceStore = {
    async settings() {
      // The row is made on first read, with a fresh salt; on by default (owner, 2026-11-25).
      await db.insert(traceShareSettings).values({ id: 1, salt: randomBytes(32).toString('base64') }).onConflictDoNothing()
      const [r] = await db.select().from(traceShareSettings).where(eq(traceShareSettings.id, 1)).limit(1)
      if (!r) throw new Error('trace_share_settings has no row after insert')
      return { enabled: r.enabled, salt: r.salt, lastSentAt: r.lastSentAt, lastError: r.lastError, updatedBy: r.updatedBy, updatedAt: r.updatedAt }
    },
    async setEnabled(enabled, by, at) {
      await store.settings()
      await setSettings({ enabled, updatedBy: by, updatedAt: at, ...(enabled ? {} : { lastError: null }) })
    },
    setSent: (at) => setSettings({ lastSentAt: at, lastError: null }),
    setLastError: (lastError, at) => setSettings({ lastError, updatedAt: at }),

    async cursor(source, now) {
      await db.insert(traceExportCursor).values({ source, lastAt: now, lastId: '', updatedAt: now }).onConflictDoNothing()
      const [r] = await db.select().from(traceExportCursor).where(eq(traceExportCursor.source, source)).limit(1)
      if (!r) throw new Error(`trace_export_cursor has no row for ${source}`)
      return { at: r.lastAt, id: r.lastId }
    },
    async createBatch(b, cursors) {
      await db.transaction(async (tx) => {
        await tx.insert(traceBatch).values({
          id: b.id,
          state: b.state,
          spanCount: b.spanCount,
          body: b.body,
          withheld: b.withheld,
          attempts: b.attempts,
          nextAttemptAt: b.nextAttemptAt,
          lastError: b.lastError,
          createdAt: b.createdAt,
        })
        for (const [source, c] of Object.entries(cursors) as Array<[TraceSource, TraceCursor]>) {
          await tx
            .update(traceExportCursor)
            .set({ lastAt: c.at, lastId: c.id, updatedAt: b.createdAt })
            .where(eq(traceExportCursor.source, source))
        }
      })
    },
    async dueBatches(now, limit) {
      const rows = await db
        .select()
        .from(traceBatch)
        .where(and(eq(traceBatch.state, 'pending'), lte(traceBatch.nextAttemptAt, now)))
        .orderBy(asc(traceBatch.createdAt))
        .limit(limit)
      return rows.map(toBatch)
    },
    async markSent(id, at) {
      await db.update(traceBatch).set({ state: 'sent', sentAt: at, lastError: null }).where(eq(traceBatch.id, id))
    },
    async markRetry(id, error, attempts, next) {
      await db.update(traceBatch).set({ lastError: error, attempts, nextAttemptAt: next }).where(eq(traceBatch.id, id))
    },
    async markFailed(id, error) {
      await db.update(traceBatch).set({ state: 'failed', lastError: error }).where(eq(traceBatch.id, id))
    },
    async markWithdrawn(id, at) {
      const rows = await db
        .update(traceBatch)
        .set({ state: 'withdrawn', withdrawnAt: at })
        .where(id === null ? eq(traceBatch.state, 'sent') : and(eq(traceBatch.state, 'sent'), eq(traceBatch.id, id)))
        .returning({ id: traceBatch.id })
      return rows.map((r) => r.id)
    },
    async listBatches(limit) {
      return (await db.select().from(traceBatch).orderBy(desc(traceBatch.createdAt)).limit(limit)).map(toBatch)
    },
    async getBatch(id) {
      const [r] = await db.select().from(traceBatch).where(eq(traceBatch.id, id)).limit(1)
      return r ? toBatch(r) : null
    },
    verdicts: dbVerdictCache(db),
  }
  return store
}

/** The box's trace tables, read after a cursor (keyset on (time, id)); only the columns a span may use. */
type Raw = Record<string, unknown>
const num = (v: unknown): number | null => (v == null ? null : Number(v))
const date = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)))

export function dbTraceSourceReader(db: AppDatabase, upgrades: (after: TraceCursor, until: Date, limit: number) => Promise<Array<TraceSourceRow & { cursor: TraceCursor }>>): TraceSourceReader {
  const rows = async (q: ReturnType<typeof sql>): Promise<Raw[]> => {
    const out = (await db.execute(q)) as unknown
    return (Array.isArray(out) ? out : ((out as { rows?: Raw[] }).rows ?? [])) as Raw[]
  }
  return async (source, after, until, limit) => {
    const a = after.at.toISOString()
    const u = until.toISOString()
    switch (source) {
      case 'llm_call':
        return (
          await rows(sql`
            SELECT id::text, created_at AS at, group_id::text AS trace_key, task, model, provider, attempt, outcome,
                   prompt_tokens, completion_tokens, base_cost_usd, duration_ms
            FROM activity_call_log
            WHERE task IS NOT NULL AND (created_at, id::text) > (${a}::timestamptz, ${after.id}) AND created_at < ${u}::timestamptz
            ORDER BY created_at, id::text LIMIT ${limit}`)
        ).map((r) => ({
          source: 'llm_call' as const,
          localId: String(r.id),
          traceKey: (r.trace_key as string | null) ?? null,
          at: date(r.at),
          task: (r.task as string | null) ?? null,
          model: (r.model as string | null) ?? null,
          provider: String(r.provider),
          attempt: num(r.attempt),
          outcome: (r.outcome as string | null) ?? null,
          tokensIn: num(r.prompt_tokens),
          tokensOut: num(r.completion_tokens),
          costUsd: num(r.base_cost_usd) ?? 0,
          durationMs: num(r.duration_ms),
          cursor: { at: date(r.at), id: String(r.id) },
        }))
      case 'tool_call':
        return (
          await rows(sql`
            SELECT id::text, ts AS at, payload->>'traceId' AS trace_key, payload->>'tool' AS tool, payload->>'auditClass' AS audit_class,
                   (payload->>'ok')::boolean AS ok, payload->>'via' AS via, (payload->>'durationMs')::numeric AS duration_ms
            FROM kernel_events
            WHERE type = 'tool.executed' AND (ts, id::text) > (${a}::timestamptz, ${after.id}) AND ts < ${u}::timestamptz
            ORDER BY ts, id::text LIMIT ${limit}`)
        ).map((r) => ({
          source: 'tool_call' as const,
          localId: String(r.id),
          traceKey: (r.trace_key as string | null) ?? null,
          at: date(r.at),
          tool: String(r.tool ?? ''),
          auditClass: String(r.audit_class ?? ''),
          ok: r.ok === true,
          via: (r.via as string | null) ?? null,
          durationMs: num(r.duration_ms),
          cursor: { at: date(r.at), id: String(r.id) },
        }))
      case 'run':
        return (
          await rows(sql`
            SELECT id::text, ended_at AS at, started_at, trigger_kind, status, stop_reason, cost_usd
            FROM coworker_run
            WHERE ended_at IS NOT NULL AND (ended_at, id::text) > (${a}::timestamptz, ${after.id}) AND ended_at < ${u}::timestamptz
            ORDER BY ended_at, id::text LIMIT ${limit}`)
        ).map((r) => {
          const ended = date(r.at)
          const started = r.started_at ? date(r.started_at) : ended
          return {
            source: 'run' as const,
            localId: String(r.id),
            traceKey: String(r.id),
            // The span starts when the run started; the cursor is its end.
            at: started,
            triggerKind: String(r.trigger_kind),
            status: String(r.status),
            stopReason: (r.stop_reason as string | null) ?? null,
            costUsd: num(r.cost_usd),
            durationMs: ended.getTime() - started.getTime(),
            cursor: { at: ended, id: String(r.id) },
          }
        })
      case 'job':
        return (
          await rows(sql`
            SELECT id::text, finished_at AS at, started_at, job_type, status, attempt_count
            FROM user_job_queue
            WHERE finished_at IS NOT NULL AND status IN ('completed', 'failed')
              AND (finished_at, id::text) > (${a}::timestamp, ${after.id}) AND finished_at < ${u}::timestamp
            ORDER BY finished_at, id::text LIMIT ${limit}`)
        ).map((r) => {
          const ended = date(r.at)
          const started = r.started_at ? date(r.started_at) : ended
          return {
            source: 'job' as const,
            localId: String(r.id),
            traceKey: String(r.id),
            at: started,
            jobType: String(r.job_type),
            ok: r.status === 'completed',
            attempt: Number(r.attempt_count ?? 1),
            durationMs: ended.getTime() - started.getTime(),
            cursor: { at: ended, id: String(r.id) },
          }
        })
      case 'upgrade':
        return upgrades(after, until, limit)
    }
  }
}
