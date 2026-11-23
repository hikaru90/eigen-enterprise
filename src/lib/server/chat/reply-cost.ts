import type { ReplyCost } from '$lib/ai-usage/usage'
import { currentTraceTokens, runWithTrace } from '$lib/server/activity/trace-context'
import { aggregateActivityCostByGroupId } from '$lib/server/activity/trace-cost'
import type { AppDatabase } from '$lib/server/db/context'

/**
 * What one assistant reply cost (proposal 30a8d920): the reply runs in its own trace, so every
 * model call made while answering it — the brain's turns and any tool that calls a model —
 * lands in the gateway's cost log under that trace's group id, and its reported tokens are
 * counted into the trace. Background work the reply queued (memory enrichment later) is not
 * part of it.
 */

export type MeasuredTurn<T> = { value: T; traceId: string; tokens: number }

/** Run one reply in a fresh trace and keep the trace id and the tokens its calls reported. */
export function runMeasuredTurn<T>(fn: () => Promise<T>): Promise<MeasuredTurn<T>> {
  const traceId = crypto.randomUUID()
  return runWithTrace(traceId, async () => {
    const value = await fn()
    return { value, traceId, tokens: currentTraceTokens() }
  })
}

/** The reply's cost from the cost log (its trace's rows for this person) plus its tokens. */
export async function readReplyCost(
  db: AppDatabase,
  userId: string,
  turn: { traceId: string; tokens: number },
): Promise<ReplyCost> {
  const aggregate = await aggregateActivityCostByGroupId(db, userId, turn.traceId)
  const costUsd = Number(aggregate.totalUsd)
  if (!Number.isFinite(costUsd) || costUsd < 0) {
    throw new Error(`The cost log sum of a reply is not a non-negative number: ${aggregate.totalUsd}`)
  }
  return { costUsd, tokens: turn.tokens, modelCalls: aggregate.callCount }
}
