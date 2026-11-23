import { describe, expect, it, vi } from 'vitest'
import { createLedgerSpentUsdToday } from './ledger-spend'

/**
 * The real spend of an agent that acts as itself (plan/phase-ai-coworkers.md §3): what its own
 * user id's model calls cost since midnight UTC, summed from the gateway's cost log — the same
 * query the member daily cap reads — inside that user's own database session.
 */
describe('createLedgerSpentUsdToday', () => {
  it('sums the cost log for the user since the start of today (UTC), inside that user’s own DB session', async () => {
    const sessions: string[] = []
    const spentUsdSince = vi.fn(async (_userId: string, _since: Date) => 1.5)
    const spentToday = createLedgerSpentUsdToday({
      spentUsdSince,
      withDbUser: async (userId, fn) => {
        sessions.push(userId)
        return fn()
      },
      now: () => new Date('2026-11-23T17:42:10.000Z'),
    })

    expect(await spentToday('cw-marketing')).toBe(1.5)
    expect(sessions).toEqual(['cw-marketing'])
    expect(spentUsdSince).toHaveBeenCalledWith('cw-marketing', new Date('2026-11-23T00:00:00.000Z'))
  })

  it('a ledger failure propagates (no "zero spend" on error)', async () => {
    const spentToday = createLedgerSpentUsdToday({
      spentUsdSince: async () => {
        throw new Error('activity_call_log unreadable')
      },
      withDbUser: async (_userId, fn) => fn(),
      now: () => new Date(),
    })
    await expect(spentToday('cw-marketing')).rejects.toThrow(/activity_call_log unreadable/)
  })
})
