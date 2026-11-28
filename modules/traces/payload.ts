import { createHmac } from 'node:crypto'
import { z } from 'zod'
import { COWORKER_STOP_REASONS, COWORKER_TRIGGER_KINDS } from '$lib/server/db/coworkers.schema'
import {
  AUDIT_CLASSES,
  CORE_TOOL_NAMES,
  ERROR_CODES,
  JOB_TYPES,
  LOG_CONTEXTS,
  OPEN_VALUE_SHAPES,
  PROVIDER_KINDS,
  RUN_KINDS,
  SPAN_KINDS,
  SPAN_OUTCOMES,
  UPGRADE_STEPS,
  VERSION_SHAPE,
  VIAS,
  type ErrorCode,
  type OpenField,
  type SpanOutcome,
} from './enums'

/**
 * The Tier A payload (plan/traces-phone-home.md §2, T1): the only thing a box ever sends about
 * how the product behaved. One pure function turns the box's own trace rows into spans whose
 * every value is from a closed set, a number, a version or a day; the strict schema below is the
 * allowlist on both ends (the hub parses with the same one). An open value (a company module's
 * tool name, a custom model id) is sent only when the box's Jev gate classified it `usage_meta`;
 * `personal_or_content` becomes the enum value `other`, and an unclassified one is not sent at all
 * (null) and listed as withheld, so the company sees it — never sent raw.
 */

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/)
const id = z.uuid()
const count = z.number().int().nonnegative()
const openTool = z.string().regex(OPEN_VALUE_SHAPES.tool)
const openModel = z.string().regex(OPEN_VALUE_SHAPES.model)

export const hubSpanV1 = z
  .object({
    trace_id: id,
    span_id: id,
    parent_id: id.nullable(),
    kind: z.enum(SPAN_KINDS),
    run_kind: z.enum(RUN_KINDS).nullable(),
    /** A core tool name, a usage_meta-classified module tool, or `other`. */
    tool: z.union([z.literal('other'), openTool]).nullable(),
    log_context: z.string().refine((v) => LOG_CONTEXTS.has(v), 'not a log context').nullable(),
    model: z.union([z.literal('other'), openModel]).nullable(),
    provider_kind: z.enum(PROVIDER_KINDS).nullable(),
    tokens_in: count.nullable(),
    tokens_out: count.nullable(),
    cost_usd: z.number().nonnegative().max(10_000).nullable(),
    duration_ms: count.nullable(),
    attempt: z.number().int().min(1).max(100).nullable(),
    start_offset_ms: count,
    outcome: z.enum(SPAN_OUTCOMES),
    error_code: z.enum(ERROR_CODES).nullable(),
    audit_class: z.enum(AUDIT_CLASSES).nullable(),
    via: z.enum(VIAS).nullable(),
    app_version: z.string().regex(VERSION_SHAPE),
    ee_version: z.string().regex(VERSION_SHAPE).nullable(),
    day,
  })
  .strict()
export type HubSpanV1 = z.infer<typeof hubSpanV1>
export const HUB_SPAN_KEYS = Object.keys(hubSpanV1.shape) as (keyof HubSpanV1)[]

/** One send: at most this many spans (the hub refuses more). */
export const MAX_SPANS_PER_BATCH = 500

export const hubTraceBatchV1 = z
  .object({
    v: z.literal(1),
    /** The local batch id: random, the hub's idempotency key. */
    batch_id: id,
    spans: z.array(hubSpanV1).min(1).max(MAX_SPANS_PER_BATCH),
  })
  .strict()
export type HubTraceBatchV1 = z.infer<typeof hubTraceBatchV1>

/** The box's own rows, as the exporter reads them (only the columns a span may use). */
export type TraceSourceRow =
  | {
      source: 'run'
      localId: string
      traceKey: string
      at: Date
      triggerKind: string
      status: string
      stopReason: string | null
      costUsd: number | null
      durationMs: number | null
    }
  | {
      source: 'llm_call'
      localId: string
      traceKey: string | null
      at: Date
      task: string | null
      model: string | null
      provider: string
      attempt: number | null
      outcome: string | null
      tokensIn: number | null
      tokensOut: number | null
      costUsd: number
      durationMs: number | null
    }
  | {
      source: 'tool_call'
      localId: string
      traceKey: string | null
      at: Date
      tool: string
      auditClass: string
      ok: boolean
      via: string | null
      durationMs: number | null
    }
  | {
      source: 'job'
      localId: string
      traceKey: string
      at: Date
      jobType: string
      ok: boolean
      attempt: number
      durationMs: number | null
    }
  | {
      source: 'upgrade'
      localId: string
      traceKey: null
      at: Date
      step: string
      ok: boolean
      rolledBack: boolean
      release: string
      durationMs: number | null
    }
  | {
      /** A company module the kernel switched off because it failed (module.failed). Its id and sentence never leave. */
      source: 'module_run'
      localId: string
      traceKey: null
      at: Date
    }

export type ValueVerdict = 'usage_meta' | 'personal_or_content' | 'unclassified'
/** The Jev gate's answers for this batch's open values (value-kind.ts fills them before the call). */
export type ValueVerdicts = { verdict: (field: OpenField, value: string) => ValueVerdict }

export type Withheld = { field: OpenField; value: string }

export type SpanContext = {
  appVersion: string
  eeVersion: string | null
  /** A per-install secret that never leaves the box: export ids are HMACs of local ids under it. */
  salt: string
  values: ValueVerdicts
}

/** A uuid-shaped HMAC of a local id: stable per install, unlinkable to the local id without the salt. */
function exportId(salt: string, what: string): string {
  const h = createHmac('sha256', salt).update(what).digest('hex')
  const variant = ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16)
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

const inSet = <T extends string>(set: readonly T[], v: string | null | undefined): T | null =>
  v != null && (set as readonly string[]).includes(v) ? (v as T) : null

const int = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.max(0, Math.round(v)))
const cost = (v: number | null | undefined): number | null => (v == null || !Number.isFinite(v) ? null : Math.round(Math.max(0, v) * 10_000) / 10_000)

function traceKeyOf(row: TraceSourceRow): string {
  return row.traceKey ?? `${row.source}:${row.localId}`
}

export function toHubSpansV1(rows: readonly TraceSourceRow[], ctx: SpanContext): { spans: HubSpanV1[]; withheld: Withheld[] } {
  const withheld: Withheld[] = []
  const starts = new Map<string, number>()
  for (const r of rows) {
    const k = traceKeyOf(r)
    const t = r.at.getTime()
    if (!starts.has(k) || t < starts.get(k)!) starts.set(k, t)
  }
  // A run's span is the parent of every other row of its trace in the batch.
  const runSpan = new Map<string, string>()
  for (const r of rows) if (r.source === 'run' || r.source === 'job') runSpan.set(traceKeyOf(r), exportId(ctx.salt, `span:${r.source}:${r.localId}`))

  const open = (field: OpenField, value: string): string | null => {
    if (!OPEN_VALUE_SHAPES[field].test(value)) {
      withheld.push({ field, value })
      return null
    }
    const v = ctx.values.verdict(field, value)
    if (v === 'usage_meta') return value
    if (v === 'personal_or_content') return 'other'
    withheld.push({ field, value })
    return null
  }

  const spans = rows.map((r): HubSpanV1 => {
    const k = traceKeyOf(r)
    const spanId = exportId(ctx.salt, `span:${r.source}:${r.localId}`)
    const parent = r.source === 'run' || r.source === 'job' || r.source === 'upgrade' || r.source === 'module_run' ? null : (runSpan.get(k) ?? null)
    const base = {
      trace_id: exportId(ctx.salt, `trace:${k}`),
      span_id: spanId,
      parent_id: parent === spanId ? null : parent,
      run_kind: null,
      tool: null,
      log_context: null,
      model: null,
      provider_kind: null,
      tokens_in: null,
      tokens_out: null,
      cost_usd: null,
      duration_ms: 'durationMs' in r ? int(r.durationMs) : null,
      attempt: null,
      start_offset_ms: r.at.getTime() - starts.get(k)!,
      error_code: null,
      audit_class: null,
      via: null,
      app_version: ctx.appVersion,
      ee_version: ctx.eeVersion,
      day: r.at.toISOString().slice(0, 10),
    } satisfies Omit<HubSpanV1, 'kind' | 'outcome'>
    switch (r.source) {
      case 'run': {
        const trigger = inSet(COWORKER_TRIGGER_KINDS, r.triggerKind)
        const stop = inSet(COWORKER_STOP_REASONS, r.stopReason)
        const outcome: SpanOutcome = r.status === 'failed' ? 'error' : r.status === 'stopped' || stop ? 'stopped' : 'ok'
        return {
          ...base,
          kind: 'run',
          run_kind: trigger ? `coworker:${trigger}` : null,
          cost_usd: cost(r.costUsd),
          outcome,
          error_code: outcome === 'ok' ? null : (stop ?? 'other'),
        }
      }
      case 'llm_call': {
        const outcome: SpanOutcome = r.outcome === 'error' ? 'error' : r.outcome === 'cut_short' ? 'stopped' : 'ok'
        return {
          ...base,
          kind: 'llm_call',
          log_context: r.task != null && LOG_CONTEXTS.has(r.task) ? r.task : null,
          model: r.model == null ? null : open('model', r.model),
          provider_kind: inSet(PROVIDER_KINDS, r.provider),
          tokens_in: int(r.tokensIn),
          tokens_out: int(r.tokensOut),
          cost_usd: cost(r.costUsd),
          attempt: r.attempt != null && r.attempt >= 1 ? Math.min(100, Math.round(r.attempt)) : null,
          outcome,
          error_code: outcome === 'error' ? 'other' : null,
        }
      }
      case 'tool_call':
        return {
          ...base,
          kind: 'tool_call',
          tool: CORE_TOOL_NAMES.has(r.tool) ? r.tool : open('tool', r.tool),
          audit_class: inSet(AUDIT_CLASSES, r.auditClass),
          via: r.via == null ? 'person' : inSet(VIAS, r.via),
          outcome: r.ok ? 'ok' : 'error',
          error_code: r.ok ? null : 'other',
        }
      case 'job': {
        const type = inSet(JOB_TYPES, r.jobType)
        return {
          ...base,
          kind: 'job',
          run_kind: type ? `job:${type}` : null,
          attempt: r.attempt >= 1 ? Math.min(100, r.attempt) : null,
          outcome: r.ok ? 'ok' : 'error',
          error_code: r.ok ? null : 'job_failed',
        }
      }
      case 'upgrade': {
        const step = inSet(UPGRADE_STEPS, r.step)
        const code: ErrorCode | null = r.ok ? null : step ? `upgrade_step:${step}` : 'other'
        return {
          ...base,
          kind: 'upgrade',
          run_kind: 'upgrade',
          outcome: r.ok ? 'ok' : r.rolledBack ? 'rolled_back' : 'error',
          error_code: code,
          // The release the upgrade went to is the version the span is about.
          app_version: VERSION_SHAPE.test(r.release) ? r.release : ctx.appVersion,
        }
      }
      case 'module_run':
        // The release the box runs is the one the breakage counts against (a wave halts on it).
        return { ...base, kind: 'module_run', outcome: 'error', error_code: 'module_failed' }
    }
  })
  return { spans: spans.map((s) => hubSpanV1.parse(s)), withheld }
}
