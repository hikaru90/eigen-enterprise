import type { HubTraceStore, RunsFilter, StatsFilter, StoredSpan, StatsRow } from './store'
import { z } from 'zod'
import { SPAN_KINDS, SPAN_OUTCOMES } from '../enums'
import { hubTraceBatchV1 } from '../payload'
import { STATS_GROUPS } from './store'

/**
 * The makers' hub for product signals (plan/traces-phone-home.md T3). Installs sign every request
 * with the key they registered on the Contribute hub (one identity per install); `authenticate`
 * is that check (unknown install / bad or stale signature / replay → 401, revoked → 403, over the
 * hourly limit → 429) and runs before the body is read. Then the size limit, then the strict
 * Tier A schema — an extra key anywhere is a 400. Raw spans are kept 90 days, rollups forever.
 */

export class TraceHubError extends Error {
  constructor(
    readonly code: 'invalid' | 'too_large' | 'not_found',
    message: string,
  ) {
    super(message)
    this.name = 'TraceHubError'
  }
}
export const TRACE_HUB_ERROR_STATUS: Record<TraceHubError['code'], number> = { invalid: 400, too_large: 413, not_found: 404 }

/** A batch of 500 spans is ~300 KB; anything over this is refused before it is parsed. */
export const MAX_BODY_BYTES = 512 * 1024
export const RAW_RETENTION_DAYS = 90

export type TraceHubRequest = { method: string; path: string; headers: Headers; body: string }
export type TraceHubReply = { status: number; body: Record<string, unknown> }

export type TraceHubDeps = {
  store: HubTraceStore
  /** The Contribute hub's signature check: the install, or it throws (401/403/429). */
  authenticate: (req: TraceHubRequest) => Promise<{ installId: string }>
  now: () => number
}

const uuid = z.uuid()
const dayOf = (ms: number) => new Date(ms).toISOString().slice(0, 10)
const addDays = (day: string, n: number) => dayOf(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000)

/** POST /api/hub/traces — 201 stored, 200 the same batch again (idempotent). */
export async function ingestTraces(d: TraceHubDeps, req: TraceHubRequest): Promise<TraceHubReply> {
  const install = await d.authenticate(req)
  if (Buffer.byteLength(req.body, 'utf8') > MAX_BODY_BYTES) throw new TraceHubError('too_large', `a batch is at most ${MAX_BODY_BYTES} bytes`)
  let raw: unknown
  try {
    raw = JSON.parse(req.body)
  } catch {
    throw new TraceHubError('invalid', 'expected a JSON body')
  }
  const parsed = hubTraceBatchV1.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    throw new TraceHubError('invalid', `invalid body: ${issue?.path.join('.') || '(root)'}: ${issue?.message ?? 'does not match'}`)
  }
  const outcome = await d.store.insertBatch(install.installId, parsed.data.batch_id, parsed.data.spans, new Date(d.now()))
  return { status: outcome === 'created' ? 201 : 200, body: { outcome, spans: parsed.data.spans.length } }
}

function noBody(req: TraceHubRequest) {
  if (req.body !== '') throw new TraceHubError('invalid', 'a DELETE carries no body')
}

/** DELETE /api/hub/traces — the install withdraws everything it sent. */
export async function withdrawAll(d: TraceHubDeps, req: TraceHubRequest): Promise<TraceHubReply> {
  const install = await d.authenticate(req)
  noBody(req)
  return { status: 200, body: { deleted: await d.store.deleteInstall(install.installId) } }
}

/** DELETE /api/hub/traces/:batchId — one batch; 200 also when it was not there (idempotent). */
export async function withdrawBatch(d: TraceHubDeps, req: TraceHubRequest, batchId: string): Promise<TraceHubReply> {
  const install = await d.authenticate(req)
  noBody(req)
  if (!uuid.safeParse(batchId).success) throw new TraceHubError('invalid', 'the batch id in the path is not a UUID')
  return { status: 200, body: { deleted: await d.store.deleteBatch(install.installId, batchId) } }
}

/** The retention job: roll up every finished day, then drop raw spans older than 90 days and revoked installs' spans. */
export async function runRetention(d: Pick<TraceHubDeps, 'store' | 'now'>): Promise<{ rolledUp: number; expired: number; revoked: number }> {
  const today = dayOf(d.now())
  const rolledUp = await d.store.rollup(today)
  const { expired, revoked } = await d.store.retention(addDays(today, -RAW_RETENTION_DAYS))
  return { rolledUp, expired, revoked }
}

// ─── The owner's reads (trace_hub.* tools) ───────────────────────────────────

export const statsInput = z
  .object({
    group_by: z.enum(STATS_GROUPS).default('tool'),
    kind: z.enum(SPAN_KINDS).nullable().default(null),
    days: z.number().int().min(1).max(3650).default(30),
  })
  .strict()

export async function hubStats(d: Pick<TraceHubDeps, 'store' | 'now'>, input: z.infer<typeof statsInput>): Promise<{ from_day: string; to_day: string; rows: StatsRow[] }> {
  const toDay = dayOf(d.now())
  const fromDay = addDays(toDay, -(input.days - 1))
  const filter: StatsFilter = { groupBy: input.group_by, kind: input.kind, fromDay, toDay }
  return { from_day: fromDay, to_day: toDay, rows: await d.store.stats(filter) }
}

export const listInput = z
  .object({
    outcome: z.enum(SPAN_OUTCOMES).nullable().default(null),
    error_code: z.string().max(80).nullable().default(null),
    app_version: z.string().max(80).nullable().default(null),
    limit: z.number().int().min(1).max(500).default(50),
  })
  .strict()

export async function hubListRuns(d: Pick<TraceHubDeps, 'store'>, input: z.infer<typeof listInput>): Promise<{ runs: StoredSpan[] }> {
  const filter: RunsFilter = { outcome: input.outcome, errorCode: input.error_code, appVersion: input.app_version, limit: input.limit }
  return { runs: await d.store.listRuns(filter) }
}

export const getInput = z.object({ install_id: z.uuid(), trace_id: z.uuid() }).strict()

export async function hubGetTrace(d: Pick<TraceHubDeps, 'store'>, input: z.infer<typeof getInput>): Promise<{ spans: StoredSpan[] }> {
  const spans = await d.store.getTrace(input.install_id, input.trace_id)
  if (spans.length === 0) throw new TraceHubError('not_found', 'no such trace on the hub')
  return { spans }
}

// ─── Waves (T5; phase-upgrades §6.3, §9 Q4) ──────────────────────────────────

export const releaseHealthInput = z.object({ release: z.string().min(1).max(80) }).strict()

const WAVE_SCAN = 500

/**
 * Whether a release's rollout wave halts: any box that rolled it back, or any company module the
 * kernel switched off as failed on a box running it. Boxes with the switch off send nothing, so a
 * wave can't halt on their failures (phase-upgrades §9 Q4).
 */
export async function hubReleaseHealth(
  d: Pick<TraceHubDeps, 'store'>,
  input: z.infer<typeof releaseHealthInput>,
): Promise<{ release: string; halt: boolean; rollbacks: number; rolled_back_installs: number; module_breakages: number; broken_installs: number }> {
  const [rolled, broken] = await Promise.all([
    d.store.listRuns({ outcome: 'rolled_back', errorCode: null, appVersion: input.release, limit: WAVE_SCAN }),
    d.store.listRuns({ outcome: 'error', errorCode: 'module_failed', appVersion: input.release, limit: WAVE_SCAN }),
  ])
  const rollbacks = rolled.filter((s) => s.kind === 'upgrade')
  const breakages = broken.filter((s) => s.kind === 'module_run')
  return {
    release: input.release,
    halt: rollbacks.length > 0 || breakages.length > 0,
    rollbacks: rollbacks.length,
    rolled_back_installs: new Set(rollbacks.map((s) => s.install_id)).size,
    module_breakages: breakages.length,
    broken_installs: new Set(breakages.map((s) => s.install_id)).size,
  }
}
