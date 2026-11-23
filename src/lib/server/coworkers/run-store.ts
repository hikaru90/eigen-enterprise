import { randomUUID } from 'node:crypto'
import type { CoworkerRunStatus, CoworkerStopReason, CoworkerTriggerKind } from '$lib/server/db/coworkers.schema'

/**
 * The co-worker turn queue and run log (coworker_run, migration 0171):
 * types, the claim decision (pure) and an in-memory store for specs. The
 * Postgres store is db-run-store.ts.
 *
 * A thread is a conversation plus its thread root (null = a DM's main log).
 * Claims on one thread are serialized across every app process (the store's
 * `withThread` holds the thread's lock for the decision and its writes), so the
 * thread budget and "one turn of a co-worker in a thread at a time" hold even
 * with two server units.
 */

export type ThreadKey = { conversationId: string; threadRootId: string | null }

export type CoworkerRunRow = {
  id: string
  coworkerUserId: string
  triggerKind: CoworkerTriggerKind
  conversationId: string | null
  threadRootId: string | null
  triggerMessageId: string | null
  requestedByUserId: string | null
  status: CoworkerRunStatus
  stopReason: CoworkerStopReason | null
  costUsd: number
  triggeredAt: Date
  startedAt: Date | null
  heartbeatAt: Date | null
  endedAt: Date | null
  error: string | null
  /** The rhythm a 'rhythm' run is a slot of (C6). */
  rhythmId: string | null
  /** The assigned task an 'assignment' run works on (C6). */
  taskId: string | null
  /** What queued a proactive run, unique per co-worker (rhythm:<id>:<slot>, task:<id>, task-comment:<id>); null for a message trigger. */
  triggerKey: string | null
}

export type NewCoworkerRun = {
  coworkerUserId: string
  triggerKind: CoworkerTriggerKind
  /** Null for an assignment (it works on a task, not in a conversation). */
  conversationId: string | null
  threadRootId: string | null
  triggerMessageId: string | null
  requestedByUserId: string | null
  triggeredAt: Date
  rhythmId: string | null
  taskId: string | null
  triggerKey: string | null
}

export type CoworkerRunPatch = Partial<
  Pick<CoworkerRunRow, 'status' | 'stopReason' | 'costUsd' | 'startedAt' | 'heartbeatAt' | 'endedAt' | 'error' | 'threadRootId'>
>

/** A finished proactive run in one person's "Needs you" (coworker_run_notice, C6). */
export type CoworkerRunNotice = { run: CoworkerRunRow; userId: string; createdAt: Date }

/** Message triggers take turns in a thread (C3); rhythms and assignments are work runs (C6), claimed one by one. */
export const THREAD_TRIGGER_KINDS: readonly CoworkerTriggerKind[] = ['mention', 'dm']
export const isThreadTurn = (r: Pick<CoworkerRunRow, 'triggerKind'>): boolean => THREAD_TRIGGER_KINDS.includes(r.triggerKind)

/** What a claim may see and change of one thread, inside the thread's lock. */
export type ThreadRuns = {
  /**
   * This thread's runs that are queued or running, plus every run triggered at
   * or after `since` (every run of the thread when since is null).
   */
  relevant(since: Date | null): Promise<CoworkerRunRow[]>
  update(id: string, patch: CoworkerRunPatch): Promise<void>
}

export type CoworkerRunStore = {
  /** Queues a turn; null when this co-worker already has one for that trigger message or trigger key (another process or a redelivery won). */
  enqueue(run: NewCoworkerRun): Promise<CoworkerRunRow | null>
  get(id: string): Promise<CoworkerRunRow | null>
  /**
   * Claims a queued work run (rhythm, assignment): queued → running, atomically
   * across processes. Null when it is not queued any more, or when another run
   * on the same task is running (the task's runs go one at a time).
   */
  claimWork(id: string, now: Date): Promise<CoworkerRunRow | null>
  /** A running run whose heartbeat is older than `staleBefore` becomes failed ('interrupted'); null when it is not (any more). */
  interruptIfStale(id: string, staleBefore: Date, now: Date): Promise<CoworkerRunRow | null>
  /** Puts a finished run in these people's "Needs you" (once per person). */
  addNotices(runId: string, userIds: readonly string[], at: Date): Promise<void>
  /** A person's unacknowledged notices, newest first. */
  openNotices(userId: string): Promise<CoworkerRunNotice[]>
  /** The person acknowledged the notice; false when they have none for that run. */
  markNoticeSeen(runId: string, userId: string, at: Date): Promise<boolean>
  /** Runs `fn` holding the thread's lock (one transaction, serialized across processes). */
  withThread<T>(key: ThreadKey, fn: (runs: ThreadRuns) => Promise<T>): Promise<T>
  update(id: string, patch: CoworkerRunPatch): Promise<void>
  /** A co-worker's runs, newest trigger first. */
  listForCoworker(coworkerUserId: string, limit: number): Promise<CoworkerRunRow[]>
  /** Every queued or running turn (resumed after a restart, recovered once stale). */
  listUnfinished(): Promise<CoworkerRunRow[]>
}

/** Turns that count against the thread budget: claimed ones (a stopped turn never ran). */
const TURN_STATUSES: readonly CoworkerRunStatus[] = ['running', 'done', 'failed']

export type ClaimInput = {
  coworkerUserId: string
  now: Date
  /** A running turn whose heartbeat is older than this is lost (its process died). */
  staleBefore: Date
  /** The latest person's message in the thread; null when there is none. */
  lastHumanAt: Date | null
  /** Co-worker turns a thread allows without a person's message in between. */
  budget: number
}

export type ClaimDecision = {
  /** This co-worker's lost turns in the thread: they become failed ('interrupted'). */
  interrupted: CoworkerRunRow[]
  next:
    | { kind: 'busy' }
    | { kind: 'empty' }
    /** The next turn would exceed the thread budget: it is stopped; the note is due unless one was already posted. */
    | { kind: 'over_budget'; run: CoworkerRunRow; turnsUsed: number; noteAlreadyPosted: boolean }
    | { kind: 'claim'; run: CoworkerRunRow; turnsUsed: number }
}

const byTrigger = (a: CoworkerRunRow, b: CoworkerRunRow) => a.triggeredAt.getTime() - b.triggeredAt.getTime() || a.id.localeCompare(b.id)

/** What to do next in a thread for one co-worker, from the thread's relevant runs (pure). */
export function decideClaim(all: readonly CoworkerRunRow[], input: ClaimInput): ClaimDecision {
  // A rhythm post in a DM's main log is a work run: it neither takes nor counts as a thread turn.
  const runs = all.filter(isThreadTurn)
  const mine = runs.filter((r) => r.coworkerUserId === input.coworkerUserId)
  const running = mine.filter((r) => r.status === 'running')
  const interrupted = running.filter((r) => (r.heartbeatAt ?? r.startedAt ?? r.triggeredAt) < input.staleBefore)
  if (running.length > interrupted.length) return { interrupted, next: { kind: 'busy' } }
  const next = mine.filter((r) => r.status === 'queued').sort(byTrigger)[0]
  if (!next) return { interrupted, next: { kind: 'empty' } }
  const since = input.lastHumanAt
  const turnsUsed = runs.filter((r) => TURN_STATUSES.includes(r.status) && r.startedAt !== null && (since === null || r.startedAt > since)).length
  if (turnsUsed >= input.budget) {
    const noteAlreadyPosted = runs.some((r) => r.stopReason === 'thread_budget' && (since === null || r.triggeredAt >= since))
    return { interrupted, next: { kind: 'over_budget', run: next, turnsUsed, noteAlreadyPosted } }
  }
  return { interrupted, next: { kind: 'claim', run: next, turnsUsed } }
}

const threadOf = (r: CoworkerRunRow): string => `${r.conversationId}:${r.threadRootId ?? 'main'}`

/** In-memory store for specs: the same contract, one process. */
export class MemoryCoworkerRunStore implements CoworkerRunStore {
  readonly rows: CoworkerRunRow[] = []
  readonly notices: { runId: string; userId: string; createdAt: Date; seenAt: Date | null }[] = []
  private locks = new Map<string, Promise<unknown>>()

  async enqueue(run: NewCoworkerRun): Promise<CoworkerRunRow | null> {
    if (run.triggerMessageId && this.rows.some((r) => r.coworkerUserId === run.coworkerUserId && r.triggerMessageId === run.triggerMessageId)) {
      return null
    }
    if (run.triggerKey && this.rows.some((r) => r.coworkerUserId === run.coworkerUserId && r.triggerKey === run.triggerKey)) return null
    const row: CoworkerRunRow = {
      ...run,
      id: randomUUID(),
      status: 'queued',
      stopReason: null,
      costUsd: 0,
      startedAt: null,
      heartbeatAt: null,
      endedAt: null,
      error: null,
    }
    this.rows.push(row)
    return { ...row }
  }

  async withThread<T>(key: ThreadKey, fn: (runs: ThreadRuns) => Promise<T>): Promise<T> {
    const name = `${key.conversationId}:${key.threadRootId ?? 'main'}`
    const before = this.locks.get(name) ?? Promise.resolve()
    const run = before.then(() =>
      fn({
        relevant: async (since) =>
          this.rows
            .filter((r) => threadOf(r) === name && (r.status === 'queued' || r.status === 'running' || since === null || r.triggeredAt >= since))
            .map((r) => ({ ...r })),
        update: (id, patch) => this.update(id, patch),
      }),
    )
    this.locks.set(
      name,
      run.catch(() => {}),
    )
    return run
  }

  async update(id: string, patch: CoworkerRunPatch): Promise<void> {
    const row = this.rows.find((r) => r.id === id)
    if (!row) throw new Error(`no coworker run ${id}`)
    Object.assign(row, patch)
  }

  async listForCoworker(coworkerUserId: string, limit: number): Promise<CoworkerRunRow[]> {
    return this.rows
      .filter((r) => r.coworkerUserId === coworkerUserId)
      .sort((a, b) => byTrigger(b, a))
      .slice(0, limit)
      .map((r) => ({ ...r }))
  }

  async listUnfinished(): Promise<CoworkerRunRow[]> {
    return this.rows.filter((r) => r.status === 'queued' || r.status === 'running').map((r) => ({ ...r }))
  }

  async get(id: string): Promise<CoworkerRunRow | null> {
    const row = this.rows.find((r) => r.id === id)
    return row ? { ...row } : null
  }

  async claimWork(id: string, now: Date): Promise<CoworkerRunRow | null> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || row.status !== 'queued') return null
    if (row.taskId && this.rows.some((r) => r.id !== id && r.taskId === row.taskId && r.status === 'running')) return null
    Object.assign(row, { status: 'running', startedAt: now, heartbeatAt: now })
    return { ...row }
  }

  async interruptIfStale(id: string, staleBefore: Date, now: Date): Promise<CoworkerRunRow | null> {
    const row = this.rows.find((r) => r.id === id)
    if (!row || row.status !== 'running' || (row.heartbeatAt ?? row.startedAt ?? row.triggeredAt) >= staleBefore) return null
    Object.assign(row, { status: 'failed', stopReason: 'interrupted', endedAt: now, error: 'the turn stopped beating: its server process ended during the turn' })
    return { ...row }
  }

  async addNotices(runId: string, userIds: readonly string[], at: Date): Promise<void> {
    for (const userId of new Set(userIds)) {
      if (this.notices.some((n) => n.runId === runId && n.userId === userId)) continue
      this.notices.push({ runId, userId, createdAt: at, seenAt: null })
    }
  }

  async openNotices(userId: string): Promise<CoworkerRunNotice[]> {
    return this.notices
      .filter((n) => n.userId === userId && n.seenAt === null)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((n) => ({ run: { ...this.rows.find((r) => r.id === n.runId)! }, userId, createdAt: n.createdAt }))
  }

  async markNoticeSeen(runId: string, userId: string, at: Date): Promise<boolean> {
    const n = this.notices.find((x) => x.runId === runId && x.userId === userId)
    if (!n) return false
    n.seenAt ??= at
    return true
  }
}
