import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import { getDb } from '$lib/server/db'
import {
  decisionLog,
  type DecisionOutcome,
  type DecisionSource,
  type DecisionStatus,
} from '$lib/server/db/decisions.schema'

/**
 * The decision log (decision_log, migration 0175): every decision of a declared kind, the
 * open "Needs you" questions, the human labels, and the per-kind counts agreement is read from.
 */

export type NewDecision = {
  kind: string
  module: string
  status: DecisionStatus
  outcome: DecisionOutcome
  inputDigest: string
  input: Record<string, unknown>
  jevChoice: string | null
  jevConfidence: number | null
  jevDistribution: Record<string, number> | null
  jevError: string | null
  model: string | null
  costUsd: number | null
  durationMs: number | null
  judgeChoice: string | null
  usedChoice: string | null
  usedSource: DecisionSource | null
  subjectUserId: string | null
  requestedBy: string
  askUserId: string | null
  question: string | null
}

export type DecisionRecord = NewDecision & {
  id: string
  humanChoice: string | null
  labelledBy: string | null
  labelledAt: Date | null
  createdAt: Date
}

/** Per-kind counts over the log (agreement.ts turns them into rates). */
export type KindCounts = {
  kind: string
  total: number
  /** Rows where Jev and the current judge both answered (shadow). */
  judgeCompared: number
  judgeAgreed: number
  /** Rows where Jev answered and a person labelled. */
  humanCompared: number
  humanAgreed: number
  /** Rows with a label or a judge answer, compared with the human label when there is one, else the judge. */
  compared: number
  agreed: number
  jevErrors: number
  openQuestions: number
  costUsd: number
}

export type DecisionStore = {
  insert(row: NewDecision): Promise<string>
  /** The latest question (outcome pending) of this kind for this input, answered or not. */
  latestQuestion(kind: string, inputDigest: string): Promise<DecisionRecord | null>
  get(id: string): Promise<DecisionRecord | null>
  /** A person's answer to an open question; false when it is not open (answered already, or none). */
  label(id: string, choice: string, by: string, at: Date): Promise<boolean>
  /**
   * A person's label on a decision that asked no one (observed, or decided by Jev or the current
   * judge): the human answer agreement is measured against. It never changes what was used.
   * A later label replaces an earlier one. False when there is no such row.
   */
  labelDecision(id: string, choice: string, by: string, at: Date): Promise<boolean>
  /** The open questions asked of this person, oldest first. */
  openQuestions(userId: string): Promise<DecisionRecord[]>
  /**
   * Recent decisions, newest first; `readerId` null = every row, else the rows about, by or asked
   * of that reader; `subjectUserId` narrows to the rows about that person or co-worker.
   */
  recent(opts: { kind?: string; subjectUserId?: string; readerId: string | null; limit: number }): Promise<DecisionRecord[]>
  kindCounts(): Promise<KindCounts[]>
}

/** Counts of one kind's rows (the in-memory store and the SQL agree on these rules; see the Postgres spec). */
export function countRows(kind: string, rows: readonly DecisionRecord[]): KindCounts {
  const reference = (r: DecisionRecord) => r.humanChoice ?? r.judgeChoice
  const withJev = rows.filter((r) => r.jevChoice !== null)
  return {
    kind,
    total: rows.length,
    judgeCompared: withJev.filter((r) => r.judgeChoice !== null).length,
    judgeAgreed: withJev.filter((r) => r.judgeChoice === r.jevChoice).length,
    humanCompared: withJev.filter((r) => r.humanChoice !== null).length,
    humanAgreed: withJev.filter((r) => r.humanChoice === r.jevChoice).length,
    compared: withJev.filter((r) => reference(r) !== null).length,
    agreed: withJev.filter((r) => reference(r) === r.jevChoice).length,
    jevErrors: rows.filter((r) => r.jevError !== null).length,
    openQuestions: rows.filter((r) => r.outcome === 'pending' && r.humanChoice === null).length,
    costUsd: rows.reduce((sum, r) => sum + (r.costUsd ?? 0), 0),
  }
}

/** Decisions a person may label afterwards (a question is answered instead). */
export const LABELLABLE_OUTCOMES = ['observed', 'decided'] as const

const readable = (r: DecisionRecord, readerId: string) =>
  r.subjectUserId === readerId || r.requestedBy === readerId || r.askUserId === readerId

/** For specs: the same contract in memory. */
export function inMemoryDecisionStore(): DecisionStore & { rows(): DecisionRecord[] } {
  const rows: DecisionRecord[] = []
  let tick = 0
  return {
    rows: () => rows,
    insert: async (row) => {
      const id = randomUUID()
      rows.push({ ...row, id, humanChoice: null, labelledBy: null, labelledAt: null, createdAt: new Date(Date.UTC(2026, 10, 23) + tick++) })
      return id
    },
    latestQuestion: async (kind, digest) =>
      rows.filter((r) => r.kind === kind && r.inputDigest === digest && r.outcome === 'pending').at(-1) ?? null,
    get: async (id) => rows.find((r) => r.id === id) ?? null,
    label: async (id, choice, by, at) => {
      const r = rows.find((x) => x.id === id && x.outcome === 'pending' && x.humanChoice === null)
      if (!r) return false
      Object.assign(r, { humanChoice: choice, labelledBy: by, labelledAt: at, usedChoice: choice, usedSource: 'human' })
      return true
    },
    labelDecision: async (id, choice, by, at) => {
      const r = rows.find((x) => x.id === id && (LABELLABLE_OUTCOMES as readonly string[]).includes(x.outcome))
      if (!r) return false
      Object.assign(r, { humanChoice: choice, labelledBy: by, labelledAt: at })
      return true
    },
    openQuestions: async (userId) => rows.filter((r) => r.askUserId === userId && r.outcome === 'pending' && r.humanChoice === null),
    recent: async ({ kind, subjectUserId, readerId, limit }) =>
      rows
        .filter(
          (r) =>
            (kind === undefined || r.kind === kind) &&
            (subjectUserId === undefined || r.subjectUserId === subjectUserId) &&
            (readerId === null || readable(r, readerId)),
        )
        .reverse()
        .slice(0, limit),
    kindCounts: async () => [...new Set(rows.map((r) => r.kind))].sort().map((k) => countRows(k, rows.filter((r) => r.kind === k))),
  }
}

function toRecord(row: typeof decisionLog.$inferSelect): DecisionRecord {
  return { ...row, costUsd: row.costUsd === null ? null : Number(row.costUsd) }
}

const n = (expr: ReturnType<typeof sql>) => sql<number>`(${expr})::int`

/** The decision log in Postgres (getDb: the request's or the background handle). */
export const liveDecisionStore: DecisionStore = {
  insert: async (row) => {
    const [inserted] = await getDb()
      .insert(decisionLog)
      .values({ ...row, costUsd: row.costUsd === null ? null : row.costUsd.toFixed(10) })
      .returning({ id: decisionLog.id })
    return inserted!.id
  },
  latestQuestion: async (kind, digest) => {
    const [row] = await getDb()
      .select()
      .from(decisionLog)
      .where(and(eq(decisionLog.kind, kind), eq(decisionLog.inputDigest, digest), eq(decisionLog.outcome, 'pending')))
      .orderBy(desc(decisionLog.createdAt))
      .limit(1)
    return row ? toRecord(row) : null
  },
  get: async (id) => {
    const [row] = await getDb().select().from(decisionLog).where(eq(decisionLog.id, id)).limit(1)
    return row ? toRecord(row) : null
  },
  label: async (id, choice, by, at) => {
    const updated = await getDb()
      .update(decisionLog)
      .set({ humanChoice: choice, labelledBy: by, labelledAt: at, usedChoice: choice, usedSource: 'human' })
      .where(and(eq(decisionLog.id, id), eq(decisionLog.outcome, 'pending'), isNull(decisionLog.humanChoice)))
      .returning({ id: decisionLog.id })
    return updated.length === 1
  },
  labelDecision: async (id, choice, by, at) => {
    const updated = await getDb()
      .update(decisionLog)
      .set({ humanChoice: choice, labelledBy: by, labelledAt: at })
      .where(and(eq(decisionLog.id, id), inArray(decisionLog.outcome, [...LABELLABLE_OUTCOMES])))
      .returning({ id: decisionLog.id })
    return updated.length === 1
  },
  openQuestions: async (userId) =>
    (
      await getDb()
        .select()
        .from(decisionLog)
        .where(and(eq(decisionLog.askUserId, userId), eq(decisionLog.outcome, 'pending'), isNull(decisionLog.humanChoice)))
        .orderBy(decisionLog.createdAt)
    ).map(toRecord),
  recent: async ({ kind, subjectUserId, readerId, limit }) =>
    (
      await getDb()
        .select()
        .from(decisionLog)
        .where(
          and(
            kind === undefined ? undefined : eq(decisionLog.kind, kind),
            subjectUserId === undefined ? undefined : eq(decisionLog.subjectUserId, subjectUserId),
            readerId === null
              ? undefined
              : or(eq(decisionLog.subjectUserId, readerId), eq(decisionLog.requestedBy, readerId), eq(decisionLog.askUserId, readerId)),
          ),
        )
        .orderBy(desc(decisionLog.createdAt))
        .limit(limit)
    ).map(toRecord),
  kindCounts: async () => {
    const t = decisionLog
    const reference = sql`coalesce(${t.humanChoice}, ${t.judgeChoice})`
    const rows = await getDb()
      .select({
        kind: t.kind,
        total: n(sql`count(*)`),
        judgeCompared: n(sql`count(*) filter (where ${t.jevChoice} is not null and ${t.judgeChoice} is not null)`),
        judgeAgreed: n(sql`count(*) filter (where ${t.jevChoice} = ${t.judgeChoice})`),
        humanCompared: n(sql`count(*) filter (where ${t.jevChoice} is not null and ${t.humanChoice} is not null)`),
        humanAgreed: n(sql`count(*) filter (where ${t.jevChoice} = ${t.humanChoice})`),
        compared: n(sql`count(*) filter (where ${t.jevChoice} is not null and ${reference} is not null)`),
        agreed: n(sql`count(*) filter (where ${t.jevChoice} = ${reference})`),
        jevErrors: n(sql`count(*) filter (where ${t.jevError} is not null)`),
        openQuestions: n(sql`count(*) filter (where ${t.outcome} = 'pending' and ${t.humanChoice} is null)`),
        costUsd: sql<string>`coalesce(sum(${t.costUsd}), 0)`,
      })
      .from(t)
      .groupBy(t.kind)
      .orderBy(t.kind)
    return rows.map((r) => ({ ...r, costUsd: Number(r.costUsd) }))
  },
}
