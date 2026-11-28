import type { TraceSourceRow, Withheld } from './payload'
import type { VerdictCache } from './value-kind'

/** The sources the exporter reads, each through its own cursor (plan/traces-phone-home.md §3). */
export const TRACE_SOURCES = ['llm_call', 'tool_call', 'run', 'job', 'upgrade'] as const
export type TraceSource = (typeof TRACE_SOURCES)[number]

export type TraceCursor = { at: Date; id: string }

export type TraceSettings = {
  enabled: boolean
  /** Never leaves the box: export ids are HMACs under it. */
  salt: string
  lastSentAt: Date | null
  lastError: string | null
  updatedBy: string | null
  updatedAt: Date
}

export const BATCH_STATES = ['pending', 'sent', 'failed', 'withdrawn'] as const
export type BatchState = (typeof BATCH_STATES)[number]

export type TraceBatch = {
  id: string
  state: BatchState
  spanCount: number
  /** The exact JSON body sent (hubTraceBatchV1). */
  body: unknown
  withheld: Withheld[]
  attempts: number
  nextAttemptAt: Date
  lastError: string | null
  createdAt: Date
  sentAt: Date | null
  withdrawnAt: Date | null
}

export type TraceStore = {
  /** The settings row, made on first read (on by default, a fresh salt). */
  settings(): Promise<TraceSettings>
  setEnabled(enabled: boolean, by: string, at: Date): Promise<void>
  setSent(at: Date): Promise<void>
  setLastError(error: string | null, at: Date): Promise<void>

  /** The cursor of a source; made at `now` on first read (no backfill: only rows after the feature lands). */
  cursor(source: TraceSource, now: Date): Promise<TraceCursor>
  /** A batch and the cursors it advances, in one transaction: a row is in exactly one batch. */
  createBatch(batch: TraceBatch, cursors: Partial<Record<TraceSource, TraceCursor>>): Promise<void>
  dueBatches(now: Date, limit: number): Promise<TraceBatch[]>
  markSent(id: string, at: Date): Promise<void>
  markRetry(id: string, error: string, attempts: number, next: Date): Promise<void>
  markFailed(id: string, error: string): Promise<void>
  /** Withdrawn from the hub: one batch, or (no id) every sent one. Returns the ids. */
  markWithdrawn(id: string | null, at: Date): Promise<string[]>
  listBatches(limit: number): Promise<TraceBatch[]>
  getBatch(id: string): Promise<TraceBatch | null>

  verdicts: VerdictCache
}

/** Rows of one source after its cursor, oldest first, settled before `until` (late commits are not missed). */
export type TraceSourceReader = (source: TraceSource, after: TraceCursor, until: Date, limit: number) => Promise<Array<TraceSourceRow & { cursor: TraceCursor }>>
