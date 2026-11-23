import { activityProviderForLlmConfig } from '$lib/server/activity/gateway-providers'
import { logActivityCall } from '$lib/server/activity/log-call'
import { getDb } from '$lib/server/db'
import { LlmHttpError, LlmNotConfiguredError } from './errors'
import { gatewayReportedCostUsdForLog } from './gateway-cost'
import { gatewayHostFromBaseUrl } from './llm-client'
import { assertGatewayCallWithinMemberDailyCap } from './member-daily-cap'
import { resolveSlot, type SlotTarget } from './slots'

/**
 * The gateway's decision call (plan/phase-company-brain.md §5–§6, CB2): a closed-set
 * question goes to the company's decision slot (Jev, `typesafe/jev-1.13`), never to a chat
 * model. Like every gateway call it resolves the slot for the company (eigenInference or the
 * company's own OpenRouter key), checks the member's daily cap, and writes one
 * activity_call_log row per attempt on the acting user (cost provider-reported, never inferred).
 *
 * Contract (OpenRouter's Decisions API, checked live 2026-11-23; `typesafe/jev-1.13` is
 * unlisted in /api/v1/models and refuses /chat/completions):
 *   POST <origin>/api/alpha/decisions   (the sibling of the OpenAI-compatible /api/v1)
 *   { model, state, questions: { [id]: { type: 'choice', instructions, criteria: { [choice]: criterion } } } }
 *   → { model: 'typesafe/jev-1.13-20260917', answers: { [id]: { type: 'choice', choice, probabilities, confidence } },
 *       usage: { input_tokens, output_tokens, cost, … }, id, provider: 'TypeSafe' }
 * Many questions per call (one state). Other question types exist (score, box, noul); only
 * `choice` is used here.
 *
 * The state is never logged (it may be a private mail or a Memory thought): the cost row names
 * the caller's context and the number of questions only.
 */

export type DecisionQuestion = {
  instructions: string
  /** The closed set: choice key → the criterion that picks it. At least two. */
  criteria: Record<string, string>
}

export type DecisionAnswer = {
  choice: string
  /** Jev's calibrated confidence (0–1) in its choice. */
  confidence: number
  /** Probability per choice of the closed set. */
  distribution: Record<string, number>
}

export type LlmDecideResult = {
  /** The model that answered, as the provider reports it (a dated snapshot of the pool id). */
  model: string
  answers: Record<string, DecisionAnswer>
  /** Provider-reported USD for the call (0 when the provider reported none). */
  costUsd: number
  durationMs: number
}

/** Jev answered with a choice outside the question's closed set: fail loud, never remap. */
export class DecisionOutOfSetError extends Error {
  constructor(
    readonly questionId: string,
    readonly choice: string,
    readonly allowed: string[],
  ) {
    super(`The decision model answered "${choice}" to "${questionId}", which is not one of ${allowed.join(', ')}.`)
    this.name = 'DecisionOutOfSetError'
  }
}

/** The decision answer is not the Decisions API's shape. */
export class DecisionResponseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionResponseError'
  }
}

export type LlmDecideDeps = {
  resolve: (userId: string) => Promise<SlotTarget>
  capCheck: (userId: string) => Promise<void>
  fetch: typeof fetch
  logCall: (
    userId: string,
    entry: { provider: string; gatewayHost: string; operation: string; baseCostUsd: number; context: string; errorMessage?: string; durationMs: number },
  ) => Promise<void>
  now: () => number
}

export const liveLlmDecideDeps: LlmDecideDeps = {
  resolve: (userId) => resolveSlot('decision', userId),
  capCheck: (userId) => assertGatewayCallWithinMemberDailyCap(userId),
  fetch: (...args) => fetch(...args),
  logCall: (userId, entry) => logActivityCall(getDb(), userId, entry),
  now: () => Date.now(),
}

const DECISION_TIMEOUT_MS = 15_000
const MAX_ATTEMPTS = 3

/** The Decisions API next to an OpenAI-compatible `/v1` base (OpenRouter: /api/v1 → /api/alpha/decisions). */
export function decisionsUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '')
  if (!base.endsWith('/v1')) {
    throw new LlmNotConfiguredError(
      `The decision slot needs an OpenRouter-compatible endpoint (an API base ending in /v1, its Decisions API beside it); ${base} is not one.`,
    )
  }
  return `${base.slice(0, -'/v1'.length)}/alpha/decisions`
}

function assertQuestions(questions: Record<string, DecisionQuestion>): void {
  const ids = Object.keys(questions)
  if (ids.length === 0) throw new Error('llmDecide needs at least one question.')
  for (const id of ids) {
    const q = questions[id]!
    if (!q.instructions.trim()) throw new Error(`Decision question "${id}" has no instructions.`)
    if (Object.keys(q.criteria).length < 2) throw new Error(`Decision question "${id}" needs at least two choices.`)
  }
}

function probability(value: unknown, where: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new DecisionResponseError(`${where} is not a probability between 0 and 1.`)
  }
  return value
}

/** Parses one answer; a choice or a probability key outside the closed set fails loud. */
function parseAnswer(id: string, raw: unknown, criteria: Record<string, string>): DecisionAnswer {
  const allowed = Object.keys(criteria)
  if (!raw || typeof raw !== 'object') throw new DecisionResponseError(`The decision answer to "${id}" is missing.`)
  const a = raw as { type?: unknown; choice?: unknown; probabilities?: unknown; confidence?: unknown }
  if (a.type !== 'choice') throw new DecisionResponseError(`The decision answer to "${id}" is not a choice.`)
  if (typeof a.choice !== 'string') throw new DecisionResponseError(`The decision answer to "${id}" has no choice.`)
  if (!allowed.includes(a.choice)) throw new DecisionOutOfSetError(id, a.choice, allowed)
  if (!a.probabilities || typeof a.probabilities !== 'object' || Array.isArray(a.probabilities)) {
    throw new DecisionResponseError(`The decision answer to "${id}" has no probabilities.`)
  }
  const distribution: Record<string, number> = {}
  for (const [key, p] of Object.entries(a.probabilities as Record<string, unknown>)) {
    if (!allowed.includes(key)) throw new DecisionOutOfSetError(id, key, allowed)
    distribution[key] = probability(p, `The probability of "${key}" for "${id}"`)
  }
  return { choice: a.choice, confidence: probability(a.confidence, `The confidence for "${id}"`), distribution }
}

function parseResponse(body: unknown, questions: Record<string, DecisionQuestion>): { model: string; answers: Record<string, DecisionAnswer> } {
  const root = body as { model?: unknown; answers?: unknown } | null
  if (!root || typeof root !== 'object' || !root.answers || typeof root.answers !== 'object') {
    throw new DecisionResponseError('The decision response has no answers.')
  }
  if (typeof root.model !== 'string' || !root.model) throw new DecisionResponseError('The decision response names no model.')
  const answers: Record<string, DecisionAnswer> = {}
  for (const [id, q] of Object.entries(questions)) {
    answers[id] = parseAnswer(id, (root.answers as Record<string, unknown>)[id], q.criteria)
  }
  return { model: root.model, answers }
}

/** The API's own error message (never the request body or the key). */
function httpDetail(text: string): string {
  try {
    const json = JSON.parse(text) as { error?: { message?: unknown } }
    if (typeof json.error?.message === 'string') return json.error.message.slice(0, 500)
  } catch {
    // not JSON
  }
  return text.slice(0, 200)
}

/**
 * One decision call: every question is answered from its closed set, or the call fails loud
 * (out-of-set answer, malformed response, missing slot/key, a model outside the pool).
 * A refusal (4xx) and an out-of-set answer are not retried; transport errors and 5xx are,
 * up to three attempts.
 */
export async function llmDecide(
  input: {
    /** Who the call is for: cost, the daily cap and the company's slot resolve on this user. */
    userId: string
    /** What Jev reads: the one text every question is asked about. */
    state: string
    questions: Record<string, DecisionQuestion>
    /** Names the caller in the cost row (a decision kind id); never content. */
    logContext: string
  },
  deps: LlmDecideDeps = liveLlmDecideDeps,
): Promise<LlmDecideResult> {
  assertQuestions(input.questions)
  await deps.capCheck(input.userId)
  const target = await deps.resolve(input.userId)
  if (!target.model) throw new LlmNotConfiguredError('The decision slot resolved without a model.')
  const model = target.model
  const url = decisionsUrl(target.config.baseUrl)
  const provider = activityProviderForLlmConfig(target.config.provider)
  const gatewayHost = gatewayHostFromBaseUrl(target.config.baseUrl)
  const context = `decide:${input.logContext} questions=${Object.keys(input.questions).length}`
  const body = JSON.stringify({
    model,
    state: input.state,
    questions: Object.fromEntries(
      Object.entries(input.questions).map(([id, q]) => [id, { type: 'choice', instructions: q.instructions, criteria: q.criteria }]),
    ),
  })

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const started = deps.now()
    let retry = true
    try {
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(new Error(`Decision request timed out after ${DECISION_TIMEOUT_MS}ms`)), DECISION_TIMEOUT_MS)
      let res: Response
      try {
        res = await deps.fetch(url, {
          method: 'POST',
          signal: ac.signal,
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.config.apiKey}` },
          body,
        })
      } finally {
        clearTimeout(timer)
      }
      const text = await res.text()
      if (!res.ok) {
        retry = res.status >= 500 || res.status === 429
        throw new LlmHttpError(res.status, httpDetail(text))
      }
      retry = false
      let json: unknown
      try {
        json = JSON.parse(text)
      } catch {
        throw new DecisionResponseError(`The decision response is not JSON (HTTP ${res.status}).`)
      }
      const parsed = parseResponse(json, input.questions)
      const costUsd = gatewayReportedCostUsdForLog(json)
      const durationMs = deps.now() - started
      await deps.logCall(input.userId, {
        provider,
        gatewayHost,
        operation: `llm.decide.success(attempt=${attempt},model=${model})`,
        baseCostUsd: costUsd,
        context: costUsd === 0 ? `${context} (usage cost missing from gateway)` : context,
        durationMs,
      })
      return { ...parsed, costUsd, durationMs }
    } catch (err) {
      lastError = err
      await deps.logCall(input.userId, {
        provider,
        gatewayHost,
        operation: `llm.decide.error(attempt=${attempt},model=${model})`,
        baseCostUsd: 0,
        context,
        errorMessage: err instanceof Error ? err.message : String(err),
        durationMs: deps.now() - started,
      })
      if (!retry) break
    }
  }
  throw lastError instanceof Error ? lastError : new Error(`Decision request failed after ${MAX_ATTEMPTS} attempts`)
}
