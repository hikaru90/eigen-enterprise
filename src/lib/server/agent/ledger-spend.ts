import { utcDayStart } from '$lib/server/llm/member-daily-cap'

/**
 * The real spend ledger for agents that act as themselves (AI co-workers,
 * plan/phase-ai-coworkers.md §3): AgentRuntimeOptions.spentUsdToday. What a user id's model
 * calls cost since midnight UTC, summed from the gateway's cost log (activity_call_log
 * .total_cost_usd) by the same query the member daily cap uses (member-daily-cap-store
 * spentUsdSince). It runs inside that user's own database session, so it works outside a
 * request (a co-worker turn has none) and never reads under another identity.
 */
export function createLedgerSpentUsdToday(deps: {
  spentUsdSince: (userId: string, since: Date) => Promise<number>
  withDbUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>
  now: () => Date
}): (userId: string) => Promise<number> {
  return (userId) => deps.withDbUser(userId, () => deps.spentUsdSince(userId, utcDayStart(deps.now())))
}

/** Production wiring: lazy imports keep this module free of DB imports at load. */
export const ledgerSpentUsdToday = createLedgerSpentUsdToday({
  spentUsdSince: async (userId, since) => {
    const { memberDailyCapStore } = await import('$lib/server/llm/member-daily-cap-store')
    return memberDailyCapStore.spentUsdSince(userId, since)
  },
  withDbUser: async (userId, fn) => {
    const { withDbUser } = await import('$lib/server/db')
    return withDbUser(userId, () => fn())
  },
  now: () => new Date(),
})
