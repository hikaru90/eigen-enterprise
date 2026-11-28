import type { TraceValueChoice } from './decision-kinds'
import type { TraceBatch, TraceCursor, TraceSource, TraceSourceReader, TraceStore } from './store'
import { MAX_SPANS_PER_BATCH, hubTraceBatchV1, toHubSpansV1, type TraceSourceRow, type Withheld } from './payload'
import { TRACE_SOURCES } from './store'
import { classifyOpenValues, openValuesOf, type OpenValue } from './value-kind'

/**
 * The traces exporter on the global job-queue tick (plan/traces-phone-home.md §3, T2). No second
 * write path: it reads the box's own tables after a cursor per source, classifies the batch's
 * open values (Jev gate, T1b), builds Tier A spans with toHubSpansV1, and writes the exact batch
 * with its advanced cursors in one transaction before sending — so a row is never sent twice.
 * Sending: 2xx sent · 401 register again, back off · 403 the hub refused this install, stop ·
 * 429 / 5xx / no answer back off 1 min doubling to 6 h (offline boxes catch up) · any other
 * answer: that batch failed, stop and show it. Switched off: nothing is read or sent.
 */

export const TRACE_PATHS = {
  traces: '/api/hub/traces',
  batch: (batchId: string) => `/api/hub/traces/${batchId}`,
} as const

/** Rows younger than this are left for the next tick (a late commit can't slip behind the cursor). */
export const SETTLE_MS = 60_000
export const SEND_PER_TICK = 5
/**
 * At most one new batch per this interval: the hub's per-install limit (60 requests an hour) is
 * shared with Contribute, so a box sends ≤ 4 batches an hour (≤ 2,000 spans), and catches up after.
 */
export const BUILD_EVERY_MS = 15 * 60_000
export const BACKOFF_BASE_MS = 60_000
export const BACKOFF_CAP_MS = 6 * 60 * 60_000

export const backoffMs = (attempts: number) => Math.min(BACKOFF_BASE_MS * 2 ** Math.max(0, attempts - 1), BACKOFF_CAP_MS)

export type TraceHubResponse = { status: number; text: string }

/** The hub, as the box reaches it: the install's identity and transport are Contribute's (one per install). */
export type TraceHub = {
  config(): { ok: true } | { ok: false; message: string }
  /** The install is registered with the hub and not refused. */
  ready(): Promise<{ ok: true } | { ok: false; revoked: boolean; message: string }>
  /** A signed request; throws when there is no answer. */
  send(req: { method: 'POST' | 'DELETE'; path: string; body: string }): Promise<TraceHubResponse>
  /** 401: the hub does not know this install (any more) — register again next tick. */
  unauthorized(): Promise<void>
}

export type TraceWorkerDeps = {
  store: TraceStore
  read: TraceSourceReader
  hub: TraceHub
  decide: (v: OpenValue) => Promise<TraceValueChoice>
  appVersion: string
  eeVersion: string | null
  now: () => Date
  newId: () => string
}

export type TraceTickResult = {
  skipped: 'off' | 'not_configured' | 'not_ready' | null
  built: number
  spans: number
  sent: number
  retried: number
  failed: number
}

const empty = (skipped: TraceTickResult['skipped']): TraceTickResult => ({ skipped, built: 0, spans: 0, sent: 0, retried: 0, failed: 0 })

export const hubAnswer = (r: TraceHubResponse) => {
  const detail = r.text.trim().slice(0, 300)
  return `The makers' hub answered HTTP ${r.status}${detail ? `: ${detail}` : ''}`
}
const noAnswer = (err: unknown) => `The makers' hub could not be reached: ${err instanceof Error ? err.message : String(err)}`.slice(0, 400)
export const REVOKED = 'The makers’ hub refused this install (HTTP 403). Nothing more is sent.'

/** Read every source after its cursor (≤ one batch), classify, build and store the batch. Null: nothing new. */
export async function buildBatch(d: TraceWorkerDeps): Promise<TraceBatch | null> {
  const now = d.now()
  const [last] = await d.store.listBatches(1)
  if (last && now.getTime() - last.createdAt.getTime() < BUILD_EVERY_MS) return null
  const until = new Date(now.getTime() - SETTLE_MS)
  const rows: TraceSourceRow[] = []
  const next: Partial<Record<TraceSource, TraceCursor>> = {}
  for (const source of TRACE_SOURCES) {
    const room = MAX_SPANS_PER_BATCH - rows.length
    if (room <= 0) break
    const after = await d.store.cursor(source, now)
    const got = await d.read(source, after, until, room)
    if (got.length === 0) continue
    for (const { cursor: _c, ...row } of got) rows.push(row as TraceSourceRow)
    next[source] = got[got.length - 1]!.cursor
  }
  if (rows.length === 0) return null
  const settings = await d.store.settings()
  const gate = await classifyOpenValues(openValuesOf(rows), { cache: d.store.verdicts, decide: d.decide, now: d.now })
  const { spans, withheld } = toHubSpansV1(rows, { appVersion: d.appVersion, eeVersion: d.eeVersion, salt: settings.salt, values: gate.verdicts })
  const id = d.newId()
  const body = hubTraceBatchV1.parse({ v: 1, batch_id: id, spans })
  const seen = new Set<string>()
  const all: Withheld[] = withheld.filter((w) => {
    const k = `${w.field}\u0000${w.value}`
    return seen.has(k) ? false : (seen.add(k), true)
  })
  const batch: TraceBatch = {
    id,
    state: 'pending',
    spanCount: spans.length,
    body,
    withheld: all,
    attempts: 0,
    nextAttemptAt: now,
    lastError: null,
    createdAt: now,
    sentAt: null,
    withdrawnAt: null,
  }
  await d.store.createBatch(batch, next)
  return batch
}

export async function runTraceTick(d: TraceWorkerDeps): Promise<TraceTickResult> {
  const settings = await d.store.settings()
  if (!settings.enabled) return empty('off')
  const config = d.hub.config()
  if (!config.ok) return empty('not_configured')
  const out = empty(null)
  const built = await buildBatch(d)
  if (built) {
    out.built = 1
    out.spans = built.spanCount
  }
  const ready = await d.hub.ready()
  if (!ready.ok) {
    await d.store.setLastError(ready.message, d.now())
    return { ...out, skipped: 'not_ready' }
  }
  for (const b of await d.store.dueBatches(d.now(), SEND_PER_TICK)) {
    const r = await sendBatch(d, b)
    if (r === 'sent') out.sent++
    else if (r === 'retried') out.retried++
    else {
      out.failed++
      break
    }
    if (r === 'retried') break
  }
  return out
}

async function sendBatch(d: TraceWorkerDeps, b: TraceBatch): Promise<'sent' | 'retried' | 'stop'> {
  const retry = async (error: string) => {
    const attempts = b.attempts + 1
    await d.store.markRetry(b.id, error, attempts, new Date(d.now().getTime() + backoffMs(attempts)))
    await d.store.setLastError(error, d.now())
    return 'retried' as const
  }
  let res: TraceHubResponse
  try {
    res = await d.hub.send({ method: 'POST', path: TRACE_PATHS.traces, body: JSON.stringify(b.body) })
  } catch (err) {
    return retry(noAnswer(err))
  }
  if (res.status >= 200 && res.status < 300) {
    await d.store.markSent(b.id, d.now())
    await d.store.setSent(d.now())
    return 'sent'
  }
  if (res.status === 401) {
    await d.hub.unauthorized()
    return retry(hubAnswer(res))
  }
  if (res.status === 429 || res.status >= 500) return retry(hubAnswer(res))
  if (res.status === 403) {
    await d.store.setLastError(REVOKED, d.now())
    return 'stop'
  }
  await d.store.markFailed(b.id, hubAnswer(res))
  await d.store.setLastError(`A batch was refused and is not sent again. ${hubAnswer(res)}`, d.now())
  return 'stop'
}
