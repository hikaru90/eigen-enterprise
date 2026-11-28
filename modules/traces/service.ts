import type { BatchState, TraceBatch, TraceStore } from './store'
import { HUB_SPAN_KEYS } from './payload'
import { TRACE_PATHS, hubAnswer, type TraceHub } from './worker'

/**
 * The company's side of the traces phone-home (plan/traces-phone-home.md §4): what is shared,
 * the owner's switch, and exactly what was sent. traces.* tools and Settings → Company both call
 * these; the UI is a client of the tools.
 */

export class TracesError extends Error {
  constructor(
    readonly code: 'forbidden' | 'not_found' | 'upstream' | 'not_configured',
    message: string,
  ) {
    super(message)
    this.name = 'TracesError'
  }
}

export type TracesDeps = {
  store: TraceStore
  hub: TraceHub
  now: () => Date
}

export type TracesActor = { id: string; isOwner: boolean }

export type SentBatchSummary = {
  id: string
  state: BatchState
  spanCount: number
  withheldCount: number
  createdAt: string
  sentAt: string | null
  withdrawnAt: string | null
  lastError: string | null
}

export type SentBatch = SentBatchSummary & { body: unknown; withheld: TraceBatch['withheld'] }

export type TracesSettingsView = {
  enabled: boolean
  hubConfigured: boolean
  hubMessage: string | null
  lastSentAt: string | null
  lastError: string | null
  updatedAt: string
  /** The only fields a span has (Tier A, §2): the page shows them. */
  fields: readonly string[]
}

const iso = (d: Date | null) => (d ? d.toISOString() : null)

function summary(b: TraceBatch): SentBatchSummary {
  return {
    id: b.id,
    state: b.state,
    spanCount: b.spanCount,
    withheldCount: b.withheld.length,
    createdAt: b.createdAt.toISOString(),
    sentAt: iso(b.sentAt),
    withdrawnAt: iso(b.withdrawnAt),
    lastError: b.lastError,
  }
}

export async function sentList(d: TracesDeps, limit = 50): Promise<{ batches: SentBatchSummary[] }> {
  return { batches: (await d.store.listBatches(Math.min(Math.max(1, limit), 500))).map(summary) }
}

export async function sentGet(d: TracesDeps, id: string): Promise<SentBatch> {
  const b = await d.store.getBatch(id)
  if (!b) throw new TracesError('not_found', `No batch ${id} in what this box sent.`)
  return { ...summary(b), body: b.body, withheld: b.withheld }
}

export async function settingsGet(d: TracesDeps): Promise<TracesSettingsView> {
  const s = await d.store.settings()
  const cfg = d.hub.config()
  return {
    enabled: s.enabled,
    hubConfigured: cfg.ok,
    hubMessage: cfg.ok ? null : cfg.message,
    lastSentAt: iso(s.lastSentAt),
    lastError: s.lastError,
    updatedAt: s.updatedAt.toISOString(),
    fields: HUB_SPAN_KEYS,
  }
}

function ownerOnly(actor: TracesActor, what: string) {
  if (!actor.isOwner) throw new TracesError('forbidden', `Only the owner ${what}.`)
}

/** Withdraw one sent batch, or (no id) everything this install sent, from the hub. */
export async function withdraw(d: TracesDeps, actor: TracesActor, batchId: string | null): Promise<{ withdrawn: string[] }> {
  ownerOnly(actor, 'withdraws what was sent')
  if (batchId !== null && !(await d.store.getBatch(batchId))) throw new TracesError('not_found', `No batch ${batchId} in what this box sent.`)
  const cfg = d.hub.config()
  if (!cfg.ok) throw new TracesError('not_configured', cfg.message)
  let res
  try {
    res = await d.hub.send({ method: 'DELETE', path: batchId === null ? TRACE_PATHS.traces : TRACE_PATHS.batch(batchId), body: '' })
  } catch (err) {
    throw new TracesError('upstream', `The makers' hub could not be reached: ${err instanceof Error ? err.message : String(err)}`)
  }
  // 404: the hub has nothing (left) of it — withdrawn either way.
  if (!(res.status >= 200 && res.status < 300) && res.status !== 404) throw new TracesError('upstream', hubAnswer(res))
  return { withdrawn: await d.store.markWithdrawn(batchId, d.now()) }
}

/** The owner's switch. Off with `withdraw`: everything sent is deleted from the hub too. */
export async function settingsSet(
  d: TracesDeps,
  actor: TracesActor,
  input: { enabled: boolean; withdraw?: boolean },
): Promise<TracesSettingsView & { withdrawn: string[] }> {
  ownerOnly(actor, 'switches sharing product signals on or off')
  await d.store.setEnabled(input.enabled, actor.id, d.now())
  const withdrawn = !input.enabled && input.withdraw ? (await withdraw(d, actor, null)).withdrawn : []
  return { ...(await settingsGet(d)), withdrawn }
}

/** The one-time Needs you notice (plan/traces-phone-home.md §4): informational, not a consent step. */
export const SIGNALS_NOTICE_SENTENCE =
  'This box shares usage statistics (which tool, which model, how long, what failed, on which version — never content, names or emails) with the eigenEnterprise makers. You can switch it off in Settings → Company.'
export const SIGNALS_SETTINGS_HREF = '/settings/company'

export type SignalsNotice = { sentence: string; href: string }

/** The owner's notice until they mark it seen; nobody else gets one (the switch is the owner's). */
export async function noticeGet(d: TracesDeps, actor: TracesActor): Promise<{ notice: SignalsNotice | null }> {
  if (!actor.isOwner) return { notice: null }
  const s = await d.store.settings()
  return { notice: s.noticeSeenAt ? null : { sentence: SIGNALS_NOTICE_SENTENCE, href: SIGNALS_SETTINGS_HREF } }
}

export async function noticeSeen(d: TracesDeps, actor: TracesActor): Promise<{ seen: true }> {
  ownerOnly(actor, 'marks the product signals notice seen')
  await d.store.setNoticeSeen(d.now())
  return { seen: true }
}
