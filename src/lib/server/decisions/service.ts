import type { DecisionKindView, DecisionLogEntry, DecisionQuestionView, DecisionsPort } from '$lib/kernel/decision-tools'
import { KernelError } from '$lib/kernel/errors'
import type { DecisionKindCatalog } from './kind'
import type { DecisionRecord, DecisionStore, KindCounts } from './store'

/**
 * The decisions.* tools over the decision log and the declared kinds (CB2): kinds with their
 * agreement, the log as the reader may see it, a person's open questions and their answer.
 */

const emptyCounts = (kind: string): KindCounts => ({
  kind,
  total: 0,
  judgeCompared: 0,
  judgeAgreed: 0,
  humanCompared: 0,
  humanAgreed: 0,
  compared: 0,
  agreed: 0,
  jevErrors: 0,
  openQuestions: 0,
  costUsd: 0,
})

/** The declared kinds with their counts, then any kind the log still holds rows of but code no longer declares. */
export function kindViews(catalog: DecisionKindCatalog, counts: readonly KindCounts[]): DecisionKindView[] {
  const byKind = new Map(counts.map((c) => [c.kind, c]))
  const view = (c: KindCounts, k: ReturnType<DecisionKindCatalog['get']>): DecisionKindView => {
    const { kind: _kind, ...rest } = c
    return {
      id: c.kind,
      module: k?.module ?? c.kind.split('.')[0]!,
      title: k?.title ?? c.kind,
      declared: k !== undefined,
      status: k?.status ?? null,
      choices: k ? [...k.choices] : [],
      lowConfidence: k?.lowConfidence ?? null,
      ...rest,
      agreement: c.compared > 0 ? c.agreed / c.compared : null,
    }
  }
  const declared = catalog.list().map((k) => view(byKind.get(k.id) ?? emptyCounts(k.id), k))
  const undeclared = counts.filter((c) => catalog.get(c.kind) === undefined).map((c) => view(c, undefined))
  return [...declared, ...undeclared]
}

export function logEntry(r: DecisionRecord): DecisionLogEntry {
  return {
    id: r.id,
    kind: r.kind,
    status: r.status,
    outcome: r.outcome,
    input: r.input,
    jevChoice: r.jevChoice,
    jevConfidence: r.jevConfidence,
    jevDistribution: r.jevDistribution,
    jevError: r.jevError,
    model: r.model,
    costUsd: r.costUsd,
    judgeChoice: r.judgeChoice,
    usedChoice: r.usedChoice,
    usedSource: r.usedSource,
    subjectUserId: r.subjectUserId,
    requestedBy: r.requestedBy,
    askUserId: r.askUserId,
    question: r.question,
    humanChoice: r.humanChoice,
    labelledBy: r.labelledBy,
    labelledAt: r.labelledAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
  }
}

/** A person's open questions whose kind is still declared with someone to ask (the buttons come from the kind). */
export async function openQuestions(store: DecisionStore, catalog: DecisionKindCatalog, userId: string): Promise<DecisionQuestionView[]> {
  const rows = await store.openQuestions(userId)
  return rows.flatMap((r) => {
    const kind = catalog.get(r.kind)
    if (!kind?.ask || r.question === null) return []
    return [
      {
        id: r.id,
        kind: r.kind,
        title: kind.title,
        question: r.question,
        choices: kind.choices.map((choice) => ({ choice, label: kind.ask!.labels[choice]! })),
        askedAt: r.createdAt.toISOString(),
      },
    ]
  })
}

/** The person asked answers their open question from its closed set; the answer is the human label. */
export async function answerQuestion(
  store: DecisionStore,
  catalog: DecisionKindCatalog,
  input: { userId: string; decisionId: string; choice: string; now: Date },
): Promise<{ decisionId: string; kind: string; choice: string }> {
  const row = await store.get(input.decisionId)
  if (!row || row.outcome !== 'pending' || row.askUserId !== input.userId) {
    throw new KernelError('invalid_input', `You have no decision question ${input.decisionId}.`)
  }
  if (row.humanChoice !== null) throw new KernelError('invalid_input', 'This question was already answered.')
  const kind = catalog.get(row.kind)
  if (!kind) throw new KernelError('invalid_input', `This question’s kind (${row.kind}) is no longer declared, so it can’t be answered.`)
  if (!(kind.choices as readonly string[]).includes(input.choice)) {
    throw new KernelError('invalid_input', `“${input.choice}” is not an answer to this question; it is one of ${kind.choices.join(', ')}.`)
  }
  if (!(await store.label(row.id, input.choice, input.userId, input.now))) {
    throw new KernelError('invalid_input', 'This question was already answered.')
  }
  return { decisionId: row.id, kind: row.kind, choice: input.choice }
}

export function decisionsPort(store: DecisionStore, catalog: DecisionKindCatalog, now: () => Date = () => new Date()): DecisionsPort {
  return {
    kinds: async () => kindViews(catalog, await store.kindCounts()),
    log: async ({ kind, limit, readerId }) => (await store.recent({ ...(kind ? { kind } : {}), readerId, limit })).map(logEntry),
    questions: (userId) => openQuestions(store, catalog, userId),
    answer: (userId, decisionId, choice) => answerQuestion(store, catalog, { userId, decisionId, choice, now: now() }),
  }
}
