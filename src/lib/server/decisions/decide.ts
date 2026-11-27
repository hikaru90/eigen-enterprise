import { createHash } from 'node:crypto'
import { llmDecide } from '$lib/server/llm/llm-decide'
import { redactForLog } from '$lib/server/observability/redact-for-log'
import type { DecisionKind, DecisionStatus } from './kind'
import { liveDecisionStore, type DecisionStore, type NewDecision } from './store'

/**
 * decide(): one decision of a declared kind (plan/phase-company-brain.md §5, CB2).
 *
 * - **shadow, with a current judge:** Jev and the current judge run side by side; both answers
 *   are logged and the caller gets the **current judge's** answer. A Jev failure is logged and
 *   changes nothing for the caller; a judge failure fails the call (that is today's behaviour).
 * - **shadow, no current judge** (new behaviour, e.g. a co-worker reacting to an event): Jev's
 *   answer is logged and the result is `observed` with `act: false` — there is no choice to act
 *   on. The caller must say so with `judge: { none: true }`; there is no implicit default.
 * - **enforced:** Jev's answer is used and the current judge does not run. Below the kind's
 *   `lowConfidence` a "Needs you" question goes to the person `ask.who` names and the result is
 *   `pending` instead of a guess. The caller re-asks later (the same input finds its question):
 *   still open → the same `pending`; answered → the person's choice (`source: 'human'`), with no
 *   new Jev call. Any Jev failure fails the call (no fallback), logged as `failed`.
 *
 * Every decision is one decision_log row; the Jev call's cost is on `requestedBy` (llmDecide).
 *
 * decideMany(): many inputs of one kind about ONE state in ONE Jev call (the kind declares
 * `batch`: the shared state and each input's own question context) — e.g. one channel message
 * and one question per co-worker it may be for. Each input still gets its own decision_log row
 * and its own result, with exactly decide()'s semantics per status; the call's cost is split
 * evenly over the rows it answered (so the per-kind cost sum stays the call's cost).
 */

export type Judge<C extends string> =
  /** Today's judge for this decision (a chat model's verdict, a rule …): its answer from the closed set. */
  | { current: () => Promise<C> }
  /** No current judge: a new behaviour. In shadow nothing is acted on. */
  | { none: true }

export type DecideOptions<C extends string> = {
  /** The principal the decision is made for: the Jev call's cost and the daily cap are on this id. */
  requestedBy: string
  /** The person the decision is about, if any (who may read it in the log). */
  subjectUserId?: string | null
  judge: Judge<C>
}

export type JevView<C extends string> = { choice: C; confidence: number; distribution: Record<string, number> }

type Base = { kind: string; status: DecisionStatus; decisionId: string }

export type DecisionResult<C extends string> =
  | (Base & {
      outcome: 'decided'
      choice: C
      /** Jev's confidence when its answer is used; null for the current judge's or a person's answer. */
      confidence: number | null
      distribution: Record<string, number> | null
      source: 'jev' | 'current_judge' | 'human'
      jev: JevView<C> | null
    })
  | (Base & { outcome: 'pending'; pending: true; questionId: string })
  | (Base & { outcome: 'observed'; act: false; jev: JevView<C> | null })

export type DecideDeps = {
  ask: typeof llmDecide
  store: DecisionStore
}

export const liveDecideDeps = (): DecideDeps => ({ ask: llmDecide, store: liveDecisionStore })

const QUESTION_ID = 'decision'

/** Canonical JSON (sorted keys) of the input, hashed: the same input → the same digest. */
export function inputDigest(input: unknown): string {
  const canonical = JSON.stringify(input, (_key, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  )
  return createHash('sha256').update(canonical ?? 'undefined').digest('hex')
}

function assertInSet<C extends string>(kind: { id: string; choices: readonly C[] }, choice: string, who: string): asserts choice is C {
  if (!(kind.choices as readonly string[]).includes(choice)) {
    throw new Error(`${who} answered "${choice}" for ${kind.id}, which is not one of ${kind.choices.join(', ')}.`)
  }
}

type JevOutcome<C extends string> =
  | { ok: true; jev: JevView<C>; model: string; costUsd: number; durationMs: number }
  | { ok: false; error: unknown }

async function askJev<I, C extends string>(kind: DecisionKind<I, C>, input: I, requestedBy: string, deps: DecideDeps): Promise<JevOutcome<C>> {
  try {
    const result = await deps.ask({
      userId: requestedBy,
      state: kind.state(input),
      questions: { [QUESTION_ID]: { instructions: kind.instructions, criteria: kind.criteria } },
      task: 'decisions.judge',
      kindId: kind.id,
    })
    const answer = result.answers[QUESTION_ID]!
    // llmDecide already refuses an out-of-set answer; this narrows the type.
    assertInSet(kind, answer.choice, 'Jev')
    return { ok: true, jev: { choice: answer.choice, confidence: answer.confidence, distribution: answer.distribution }, model: result.model, costUsd: result.costUsd, durationMs: result.durationMs }
  } catch (error) {
    return { ok: false, error }
  }
}

const questionId = (n: number) => `q${n}`

/** One Jev call for many inputs of a batch kind: one outcome per input (they fail together). */
async function askJevMany<I, C extends string>(
  kind: DecisionKind<I, C>,
  batch: NonNullable<DecisionKind<I, C>['batch']>,
  state: string,
  inputs: readonly I[],
  requestedBy: string,
  deps: DecideDeps,
): Promise<JevOutcome<C>[]> {
  try {
    const result = await deps.ask({
      userId: requestedBy,
      state,
      questions: Object.fromEntries(
        inputs.map((input, n) => [questionId(n), { instructions: `${kind.instructions}\n\n${batch.question(input)}`, criteria: kind.criteria }]),
      ),
      task: 'decisions.judge',
      kindId: kind.id,
    })
    const share = result.costUsd / inputs.length
    return inputs.map((_input, n) => {
      const answer = result.answers[questionId(n)]
      if (!answer) throw new Error(`Jev gave no answer to ${questionId(n)} of ${kind.id}.`)
      assertInSet(kind, answer.choice, 'Jev')
      return {
        ok: true as const,
        jev: { choice: answer.choice, confidence: answer.confidence, distribution: answer.distribution },
        model: result.model,
        costUsd: share,
        durationMs: result.durationMs,
      }
    })
  } catch (error) {
    return inputs.map(() => ({ ok: false as const, error }))
  }
}

const message = (err: unknown) => (err instanceof Error ? `${err.name}: ${err.message}` : String(err))

type Who = { requestedBy: string; subjectUserId: string | null }

function newRow<I, C extends string>(kind: DecisionKind<I, C>, input: I, digest: string, who: Who, jev: JevOutcome<C>): NewDecision {
  return {
    kind: kind.id,
    module: kind.module,
    status: kind.status,
    outcome: 'decided',
    inputDigest: digest,
    input: redactForLog(kind.logInput(input)) as Record<string, unknown>,
    jevChoice: jev.ok ? jev.jev.choice : null,
    jevConfidence: jev.ok ? jev.jev.confidence : null,
    jevDistribution: jev.ok ? jev.jev.distribution : null,
    jevError: jev.ok ? null : message(jev.error),
    model: jev.ok ? jev.model : null,
    costUsd: jev.ok ? jev.costUsd : null,
    durationMs: jev.ok ? jev.durationMs : null,
    judgeChoice: null,
    usedChoice: null,
    usedSource: null,
    subjectUserId: who.subjectUserId,
    requestedBy: who.requestedBy,
    askUserId: null,
    question: null,
  }
}

/** An enforced kind's earlier question for this input: still open → pending; answered → the person's choice. */
async function earlierQuestion<I, C extends string>(kind: DecisionKind<I, C>, digest: string, deps: DecideDeps): Promise<DecisionResult<C> | null> {
  if (kind.status !== 'enforced') return null
  const asked = await deps.store.latestQuestion(kind.id, digest)
  if (!asked) return null
  const base = { kind: kind.id, status: kind.status }
  if (asked.humanChoice === null) return { ...base, outcome: 'pending', pending: true, questionId: asked.id, decisionId: asked.id }
  assertInSet(kind, asked.humanChoice, 'The person')
  return { ...base, outcome: 'decided', choice: asked.humanChoice, confidence: null, distribution: null, source: 'human', jev: null, decisionId: asked.id }
}

/** Logs one decision from Jev's outcome (beside the current judge's answer in shadow) and returns its result. */
async function settle<I, C extends string>(
  kind: DecisionKind<I, C>,
  input: I,
  digest: string,
  who: Who,
  jev: JevOutcome<C>,
  judged: { none: true } | { choice: C },
  deps: DecideDeps,
): Promise<DecisionResult<C>> {
  const base = { kind: kind.id, status: kind.status }
  const row = newRow(kind, input, digest, who, jev)

  if (kind.status === 'shadow') {
    if ('none' in judged) {
      if (!jev.ok) console.error(`[decisions] ${kind.id} (shadow): Jev gave no answer`, message(jev.error))
      const decisionId = await deps.store.insert({ ...row, outcome: 'observed' })
      return { ...base, outcome: 'observed', act: false, jev: jev.ok ? jev.jev : null, decisionId }
    }
    assertInSet(kind, judged.choice, 'The current judge')
    if (!jev.ok) console.error(`[decisions] ${kind.id} (shadow): Jev gave no answer; the current judge's stands`, message(jev.error))
    const decisionId = await deps.store.insert({ ...row, judgeChoice: judged.choice, usedChoice: judged.choice, usedSource: 'current_judge' })
    return { ...base, outcome: 'decided', choice: judged.choice, confidence: null, distribution: null, source: 'current_judge', jev: jev.ok ? jev.jev : null, decisionId }
  }

  if (!jev.ok) {
    await deps.store.insert({ ...row, outcome: 'failed' })
    throw jev.error
  }
  if (jev.jev.confidence < kind.lowConfidence) {
    const askUserId = kind.ask!.who(input)
    if (!askUserId) {
      await deps.store.insert({ ...row, outcome: 'failed', jevError: 'no one to ask' })
      throw new Error(`${kind.id}: Jev is unsure (${jev.jev.confidence}) and there is no one to ask.`)
    }
    const decisionId = await deps.store.insert({ ...row, outcome: 'pending', askUserId, question: kind.ask!.question(input) })
    return { ...base, outcome: 'pending', pending: true, questionId: decisionId, decisionId }
  }
  const decisionId = await deps.store.insert({ ...row, usedChoice: jev.jev.choice, usedSource: 'jev' })
  return { ...base, outcome: 'decided', choice: jev.jev.choice, confidence: jev.jev.confidence, distribution: jev.jev.distribution, source: 'jev', jev: jev.jev, decisionId }
}

export async function decide<I, C extends string>(
  kind: DecisionKind<I, C>,
  input: I,
  opts: DecideOptions<C>,
  deps: DecideDeps = liveDecideDeps(),
): Promise<DecisionResult<C>> {
  const digest = inputDigest(input)
  const earlier = await earlierQuestion(kind, digest, deps)
  if (earlier) return earlier
  const who: Who = { requestedBy: opts.requestedBy, subjectUserId: opts.subjectUserId ?? null }

  if (kind.status === 'shadow' && 'current' in opts.judge) {
    const [judged, jev] = await Promise.all([opts.judge.current(), askJev(kind, input, opts.requestedBy, deps)])
    return settle(kind, input, digest, who, jev, { choice: judged }, deps)
  }
  // Shadow with no current judge, or enforced (the current judge does not run).
  return settle(kind, input, digest, who, await askJev(kind, input, opts.requestedBy, deps), { none: true }, deps)
}

export type DecideManyItem<I> = {
  input: I
  /** The person or co-worker this item's decision is about (who may read it in the log). */
  subjectUserId?: string | null
}

export type DecideManyOptions<I, C extends string> = {
  /** The principal the one call is made for: its cost and the daily cap are on this id. */
  requestedBy: string
  /** None (a new behaviour), or today's judge, asked per item (shadow only, like decide). */
  judge: { none: true } | { current: (input: I) => Promise<C> }
}

/**
 * Many inputs of a batch kind about one state, in one Jev call: one result per item, in order,
 * each logged as its own decision exactly as decide() would. An enforced item with an earlier
 * question is answered from it and left out of the call. An enforced Jev failure logs every
 * asked item as failed and fails the call; any other per-item failure (no one to ask) fails the
 * call loud after every item's row was written.
 */
export async function decideMany<I, C extends string>(
  kind: DecisionKind<I, C>,
  items: readonly DecideManyItem<I>[],
  opts: DecideManyOptions<I, C>,
  deps: DecideDeps = liveDecideDeps(),
): Promise<DecisionResult<C>[]> {
  if (items.length === 0) throw new Error(`decideMany(${kind.id}) needs at least one item.`)
  const batch = kind.batch
  if (!batch) throw new Error(`Decision kind "${kind.id}" declares no batch (a shared state and a per-input question); decide it one input at a time.`)
  const state = batch.state(items[0]!.input)
  if (items.some((it) => batch.state(it.input) !== state)) throw new Error(`decideMany(${kind.id}): every item must be about one state.`)

  const digests = items.map((it) => inputDigest(it.input))
  const results: (DecisionResult<C> | null)[] = await Promise.all(digests.map((d) => earlierQuestion(kind, d, deps)))
  const open = items.map((_it, n) => n).filter((n) => results[n] === null)
  if (open.length === 0) return results as DecisionResult<C>[]

  const judge = kind.status === 'shadow' && 'current' in opts.judge ? opts.judge.current : null
  const [judged, asked] = await Promise.all([
    judge ? Promise.all(open.map((n) => judge(items[n]!.input))) : Promise.resolve(null),
    askJevMany(kind, batch, state, open.map((n) => items[n]!.input), opts.requestedBy, deps),
  ])

  let failure: unknown = null
  for (const [k, n] of open.entries()) {
    const who: Who = { requestedBy: opts.requestedBy, subjectUserId: items[n]!.subjectUserId ?? null }
    try {
      results[n] = await settle(kind, items[n]!.input, digests[n]!, who, asked[k]!, judged ? { choice: judged[k]! } : { none: true }, deps)
    } catch (err) {
      failure ??= err
    }
  }
  if (failure !== null) throw failure
  return results as DecisionResult<C>[]
}
