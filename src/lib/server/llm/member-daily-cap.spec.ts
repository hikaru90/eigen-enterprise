import { describe, expect, it } from 'vitest'
import type { MemberRole } from '$lib/server/auth/roles'
import { LLM_DAILY_CAP_MESSAGE, LlmDailyCapError } from './errors'
import {
  assertWithinMemberDailyCap,
  memberAiUsageToday,
  parseStoredCapUsd,
  utcDayStart,
  type MemberDailyCapDeps,
} from './member-daily-cap'

type Spend = { userId: string; at: Date; usd: number }

function deps(input: {
  cap: number | null
  roles: Record<string, MemberRole>
  coworkers?: string[]
  spends?: Spend[]
  now: Date
}): MemberDailyCapDeps & { spentQueries: Array<{ userId: string; since: Date }> } {
  const spentQueries: Array<{ userId: string; since: Date }> = []
  return {
    spentQueries,
    readCapUsd: async () => input.cap,
    roleOf: async (userId) => input.roles[userId] ?? null,
    kindOf: async (userId) => (input.roles[userId] ? ((input.coworkers ?? []).includes(userId) ? 'coworker' : 'human') : null),
    spentUsdSince: async (userId, since) => {
      spentQueries.push({ userId, since })
      return (input.spends ?? [])
        .filter((s) => s.userId === userId && s.at.getTime() >= since.getTime())
        .reduce((n, s) => n + s.usd, 0)
    },
    now: () => input.now,
  }
}

const NOON = new Date('2026-11-23T12:00:00.000Z')
const roles: Record<string, MemberRole> = { mia: 'member', ada: 'owner', ali: 'admin' }

describe('member daily AI cap: enforcement', () => {
  it('lets a member under the cap through', async () => {
    const d = deps({ cap: 1, roles, now: NOON, spends: [{ userId: 'mia', at: NOON, usd: 0.4 }] })
    await expect(assertWithinMemberDailyCap('mia', d)).resolves.toBeUndefined()
    expect(d.spentQueries).toEqual([{ userId: 'mia', since: new Date('2026-11-23T00:00:00.000Z') }])
  })

  it('refuses a member at or over the cap with the plain message', async () => {
    const d = deps({ cap: 1, roles, now: NOON, spends: [{ userId: 'mia', at: NOON, usd: 1 }] })
    const err = await assertWithinMemberDailyCap('mia', d).catch((e) => e)
    expect(err).toBeInstanceOf(LlmDailyCapError)
    expect(err.message).toBe(LLM_DAILY_CAP_MESSAGE)
    expect(err.message).toBe("You've used today's AI allowance for this company. It resets at midnight UTC.")
    expect(err).toMatchObject({ capUsd: 1, spentUsd: 1 })
  })

  it('never caps an AI co-worker (role member): its own daily cap limits it, not the per-person cap', async () => {
    const d = deps({ cap: 1, roles: { ...roles, 'cw-mkt': 'member' }, coworkers: ['cw-mkt'], now: NOON, spends: [{ userId: 'cw-mkt', at: NOON, usd: 3 }] })
    await expect(assertWithinMemberDailyCap('cw-mkt', d)).resolves.toBeUndefined()
    expect(await memberAiUsageToday('cw-mkt', d)).toMatchObject({ role: 'member', capApplies: false, remainingUsd: null, spentUsd: 3 })
    // A person with the same role and spend is refused.
    await expect(assertWithinMemberDailyCap('mia', deps({ cap: 1, roles, now: NOON, spends: [{ userId: 'mia', at: NOON, usd: 3 }] }))).rejects.toBeInstanceOf(LlmDailyCapError)
  })

  it('never caps the owner or an admin, whatever they spent', async () => {
    const spends = [
      { userId: 'ada', at: NOON, usd: 50 },
      { userId: 'ali', at: NOON, usd: 50 },
    ]
    const d = deps({ cap: 1, roles, now: NOON, spends })
    await expect(assertWithinMemberDailyCap('ada', d)).resolves.toBeUndefined()
    await expect(assertWithinMemberDailyCap('ali', d)).resolves.toBeUndefined()
    expect(d.spentQueries).toEqual([])
  })

  it('an unset cap caps nobody and reads no usage', async () => {
    const d = deps({ cap: null, roles, now: NOON, spends: [{ userId: 'mia', at: NOON, usd: 99 }] })
    await expect(assertWithinMemberDailyCap('mia', d)).resolves.toBeUndefined()
    expect(d.spentQueries).toEqual([])
  })

  it('counts the UTC day only: yesterday’s spend is gone after midnight UTC', async () => {
    const spends = [{ userId: 'mia', at: new Date('2026-11-23T23:30:00.000Z'), usd: 2 }]
    const late = deps({ cap: 1, roles, now: new Date('2026-11-23T23:59:59.000Z'), spends })
    await expect(assertWithinMemberDailyCap('mia', late)).rejects.toBeInstanceOf(LlmDailyCapError)
    const nextDay = deps({ cap: 1, roles, now: new Date('2026-11-24T00:00:01.000Z'), spends })
    await expect(assertWithinMemberDailyCap('mia', nextDay)).resolves.toBeUndefined()
    expect(nextDay.spentQueries[0]?.since).toEqual(new Date('2026-11-24T00:00:00.000Z'))
  })

  it('an id that is no person (no role) is not a member and is not capped', async () => {
    const d = deps({ cap: 1, roles, now: NOON })
    await expect(assertWithinMemberDailyCap('system:job', d)).resolves.toBeUndefined()
  })
})

describe('member daily AI cap: usage today', () => {
  it('a member sees their spend, the cap, what is left and when it resets', async () => {
    const d = deps({ cap: 1, roles, now: NOON, spends: [{ userId: 'mia', at: NOON, usd: 0.25 }] })
    expect(await memberAiUsageToday('mia', d)).toEqual({
      role: 'member',
      capUsd: 1,
      capApplies: true,
      spentUsd: 0.25,
      remainingUsd: 0.75,
      resetsAt: '2026-11-24T00:00:00.000Z',
    })
  })

  it('an admin sees their spend and that the cap does not apply to them', async () => {
    const d = deps({ cap: 1, roles, now: NOON, spends: [{ userId: 'ali', at: NOON, usd: 3 }] })
    expect(await memberAiUsageToday('ali', d)).toMatchObject({
      role: 'admin',
      capUsd: 1,
      capApplies: false,
      spentUsd: 3,
      remainingUsd: null,
    })
  })

  it('over the cap, nothing is left (never negative)', async () => {
    const d = deps({ cap: 1, roles, now: NOON, spends: [{ userId: 'mia', at: NOON, usd: 1.4 }] })
    expect((await memberAiUsageToday('mia', d)).remainingUsd).toBe(0)
  })
})

describe('member daily AI cap: stored value', () => {
  it('reads null as no cap and a positive decimal as the cap', () => {
    expect(parseStoredCapUsd(null)).toBeNull()
    expect(parseStoredCapUsd('0.5000')).toBe(0.5)
    expect(parseStoredCapUsd('12.0000')).toBe(12)
  })

  it('fails loud on anything else', () => {
    for (const bad of ['', 'abc', '0', '-1', 'NaN', 'Infinity', 3, undefined]) {
      expect(() => parseStoredCapUsd(bad)).toThrow(/member_daily_cap_usd/)
    }
  })

  it('the UTC day starts at midnight UTC whatever the local time', () => {
    expect(utcDayStart(new Date('2026-11-23T00:00:00.000Z'))).toEqual(new Date('2026-11-23T00:00:00.000Z'))
    expect(utcDayStart(new Date('2026-11-23T23:59:59.999Z'))).toEqual(new Date('2026-11-23T00:00:00.000Z'))
  })
})
