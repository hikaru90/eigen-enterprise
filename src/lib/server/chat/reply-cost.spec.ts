import { describe, expect, it, vi } from 'vitest'

const { aggregateMock } = vi.hoisted(() => ({
  aggregateMock: vi.fn(async (..._args: unknown[]) => ({
    totalUsd: '0.004200',
    totalCredits: 0,
    totalMs: 900,
    callCount: 2,
    byOperation: {},
  })),
}))
vi.mock('$lib/server/activity/trace-cost', () => ({ aggregateActivityCostByGroupId: aggregateMock }))

import { addTraceTokens, getCurrentTraceGroupId } from '$lib/server/activity/trace-context'
import { readReplyCost, runMeasuredTurn } from './reply-cost'

describe('reply cost', () => {
  it('a reply runs in its own trace and keeps the tokens its model calls reported', async () => {
    let seenGroup: string | undefined
    const turn = await runMeasuredTurn(async () => {
      seenGroup = getCurrentTraceGroupId()
      addTraceTokens(1000)
      addTraceTokens(234)
      return 'Hello.'
    })
    expect(turn.value).toBe('Hello.')
    expect(turn.tokens).toBe(1234)
    expect(turn.traceId).toBe(seenGroup)
    expect(getCurrentTraceGroupId()).toBeUndefined()
  })

  it('the cost is the cost log of that trace for that person', async () => {
    const db = {} as never
    expect(await readReplyCost(db, 'u-mia', { traceId: 't-1', tokens: 1234 })).toEqual({
      costUsd: 0.0042,
      tokens: 1234,
      modelCalls: 2,
    })
    expect(aggregateMock).toHaveBeenCalledWith(db, 'u-mia', 't-1')
  })
})
