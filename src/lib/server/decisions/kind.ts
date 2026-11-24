import { DECISION_STATUSES, type DecisionStatus } from '$lib/server/db/decisions.schema'

/**
 * Decision kinds (plan/phase-company-brain.md §5, CB2): every closed-set question the app asks
 * Jev is a declared kind — its closed set of choices with the criterion for each, its status
 * and its low-confidence threshold. A module declares its kinds next to its code
 * (`defineDecisionKind`) and lists them in the catalog (modules/decision-kinds.ts).
 *
 * Status is code: `shadow` (Jev runs next to the current judge, every decision logged, the
 * current judge's answer is used) or `enforced` (Jev's answer is used). It changes only by a
 * commit, after the decision log was reviewed (decisions.kinds shows the agreement), never at
 * runtime — the kind is frozen.
 */

export type { DecisionStatus }

export type DecisionKindDef<I, C extends string> = {
  /** `<module>.<name>`, e.g. `website.page_audience`. */
  id: string
  /** The owning module (its id prefixes the kind id). */
  module: string
  /** What the kind decides, in a few words (decisions.kinds, Needs you). */
  title: string
  /** The question Jev is asked about the state. */
  instructions: string
  /** The closed set. At least two. */
  choices: readonly C[]
  /** The criterion for each choice: exactly the choices, none empty. */
  criteria: Record<C, string>
  status: DecisionStatus
  /**
   * Below this confidence an enforced decision asks a person instead of guessing (0 = never
   * asks). Above 0 the kind must say whom to ask.
   */
  lowConfidence: number
  /** What Jev reads: the text the question is about. Sent to the model, never logged. */
  state: (input: I) => string
  /**
   * For decideMany: many inputs about one state in ONE Jev call (one message, one question per
   * co-worker it may be for). `state` is what every question of the call reads and must be the
   * same for every input of a call; `question` is the input's own part (a role card), added to
   * its question's instructions. Without it the kind is decided one input at a time (decide).
   */
  batch?: {
    state: (input: I) => string
    question: (input: I) => string
  }
  /**
   * What the decision log keeps of the input (then secret-redacted by key): enough to review the
   * decision, never more than the reader of the log may see — a mail body or a private text only
   * if the kind deliberately keeps it. Explicit per kind: there is no default.
   */
  logInput: (input: I) => Record<string, unknown>
  /** Whom to ask, and how, when an enforced decision is unsure. */
  ask?: {
    /** The person who answers (a user id), or null when there is no one (the decision then fails loud). */
    who: (input: I) => string | null
    /** The question as the person reads it in Needs you. */
    question: (input: I) => string
    /** The button label of each choice. */
    labels: Record<C, string>
  }
}

const KIND = Symbol('decision-kind')

export type DecisionKind<I, C extends string> = Readonly<DecisionKindDef<I, C>> & { readonly [KIND]: true }

/** A kind of any input and choice set (catalogs, tools). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyDecisionKind = DecisionKind<any, string>

const ID = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)$/

function sameKeys(record: Record<string, string>, choices: readonly string[]): boolean {
  const keys = Object.keys(record)
  return keys.length === choices.length && choices.every((c) => Object.hasOwn(record, c) && record[c]!.trim() !== '')
}

export function defineDecisionKind<I, C extends string>(def: DecisionKindDef<I, C>): DecisionKind<I, C> {
  const where = `Decision kind "${def.id}"`
  const id = ID.exec(def.id)
  if (!id || id[1] !== def.module) throw new Error(`${where}: the id must be <module>.<name> in its module "${def.module}".`)
  if (!(DECISION_STATUSES as readonly string[]).includes(def.status)) {
    throw new Error(`${where}: status must be shadow or enforced (got "${String(def.status)}").`)
  }
  if (!def.title.trim() || !def.instructions.trim()) throw new Error(`${where}: title and instructions are required.`)
  if (def.choices.length < 2) throw new Error(`${where}: a closed set has at least two choices.`)
  if (new Set(def.choices).size !== def.choices.length) throw new Error(`${where}: a choice is listed twice.`)
  if (!sameKeys(def.criteria, def.choices)) {
    throw new Error(`${where}: criteria must name exactly the choices (${def.choices.join(', ')}), each with a criterion.`)
  }
  if (!Number.isFinite(def.lowConfidence) || def.lowConfidence < 0 || def.lowConfidence > 1) {
    throw new Error(`${where}: lowConfidence must be between 0 and 1.`)
  }
  if (def.lowConfidence > 0 && !def.ask) {
    throw new Error(`${where}: a low-confidence threshold above 0 needs ask (whom to ask, the question, the labels).`)
  }
  if (def.ask && !sameKeys(def.ask.labels, def.choices)) {
    throw new Error(`${where}: ask.labels must name exactly the choices (${def.choices.join(', ')}).`)
  }
  return Object.freeze({
    ...def,
    choices: Object.freeze([...def.choices]),
    criteria: Object.freeze({ ...def.criteria }),
    ...(def.ask ? { ask: Object.freeze({ ...def.ask, labels: Object.freeze({ ...def.ask.labels }) }) } : {}),
    ...(def.batch ? { batch: Object.freeze({ ...def.batch }) } : {}),
    [KIND]: true as const,
  })
}

export function isDecisionKind(value: unknown): value is AnyDecisionKind {
  return typeof value === 'object' && value !== null && (value as Record<symbol, unknown>)[KIND] === true
}

export type DecisionKindCatalog = {
  list(): readonly AnyDecisionKind[]
  get(id: string): AnyDecisionKind | undefined
}

/** The declared kinds; fails when two share an id. */
export function decisionKindCatalog(kinds: readonly AnyDecisionKind[]): DecisionKindCatalog {
  const byId = new Map<string, AnyDecisionKind>()
  for (const kind of kinds) {
    if (!isDecisionKind(kind)) throw new Error('A decision kind must be made with defineDecisionKind.')
    if (byId.has(kind.id)) throw new Error(`Decision kind "${kind.id}" is declared twice.`)
    byId.set(kind.id, kind)
  }
  const list = Object.freeze([...byId.values()])
  return { list: () => list, get: (id) => byId.get(id) }
}
