import { describe, expect, it } from 'vitest'
import { MAX_RAW_GATEWAY_CALLS_PER_DEMO_TURN, type ActiveDemoGuest } from '$lib/server/demo/guest-access'
import { assertWithinDemoGuestAiLimit, type DemoGuestAiLimitDeps } from './demo-guest-ai-limit'
import { demoGuestAiLimitMessage, LlmDailyCapError } from './errors'
import { requestAiContextAsyncLocal, runWithRequestAiContext } from './request-context'

const GUEST: ActiveDemoGuest = {
  userId: 'u-sophie',
  email: 'sophie.wagner@northwind-studio.example',
  name: 'Sophie Wagner',
  aiCallsPerIp: 2,
}

function makeDeps(guest: ActiveDemoGuest | null = GUEST) {
  const counts = new Map<string, number>()
  let day = new Date('2026-11-24T12:00:00Z')
  const deps: DemoGuestAiLimitDeps = {
    activeDemoGuest: async () => guest,
    claimCall: async (ipHash, dayUtc, limit) => {
      const key = `${ipHash}:${dayUtc}`
      const cur = counts.get(key) ?? 0
      if (cur >= limit) return { allowed: false, used: cur }
      counts.set(key, cur + 1)
      return { allowed: true, used: cur + 1 }
    },
    requestContext: () => requestAiContextAsyncLocal.getStore(),
    now: () => day,
  }
  return { deps, counts, setDay: (d: Date) => (day = d) }
}

describe('demo guest per-IP AI call limit', () => {
  it('does nothing for non-guest users or when demo guest access is off', async () => {
    const off = makeDeps(null)
    await expect(assertWithinDemoGuestAiLimit('u-sophie', off.deps)).resolves.toBeUndefined()

    const on = makeDeps(GUEST)
    await expect(assertWithinDemoGuestAiLimit('u-owner', on.deps)).resolves.toBeUndefined()
    expect(on.counts.size).toBe(0)
  })

  it('allows up to 2 AI turns per IP per UTC day, counting multi-step tool turns as 1 turn', async () => {
    const { deps, setDay } = makeDeps(GUEST)

    // Turn 1: multiple internal gateway calls (e.g. chat + embedding + synthesis) count once
    await runWithRequestAiContext('203.0.113.10', async () => {
      await assertWithinDemoGuestAiLimit('u-sophie', deps)
      await assertWithinDemoGuestAiLimit('u-sophie', deps)
      await assertWithinDemoGuestAiLimit('u-sophie', deps)
    })

    // Turn 2 from same IP: allowed
    await runWithRequestAiContext('203.0.113.10', async () => {
      await assertWithinDemoGuestAiLimit('u-sophie', deps)
    })

    // Turn 3 from same IP: refused with clear demo message
    await runWithRequestAiContext('203.0.113.10', async () => {
      const err = await assertWithinDemoGuestAiLimit('u-sophie', deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmDailyCapError)
      expect((err as Error).message).toBe(demoGuestAiLimitMessage(2))
    })

    // Different IP still gets its own 2 turns
    await runWithRequestAiContext('198.51.100.7', async () => {
      await assertWithinDemoGuestAiLimit('u-sophie', deps)
    })

    // Next UTC day resets the IP's quota
    setDay(new Date('2026-11-25T00:00:01Z'))
    await runWithRequestAiContext('203.0.113.10', async () => {
      await assertWithinDemoGuestAiLimit('u-sophie', deps)
    })
  })

  it('caps runaway raw gateway calls inside a single turn', async () => {
    const { deps } = makeDeps(GUEST)
    await runWithRequestAiContext('203.0.113.11', async () => {
      for (let i = 0; i < MAX_RAW_GATEWAY_CALLS_PER_DEMO_TURN; i++) {
        await assertWithinDemoGuestAiLimit('u-sophie', deps)
      }
      await expect(assertWithinDemoGuestAiLimit('u-sophie', deps)).rejects.toBeInstanceOf(LlmDailyCapError)
    })
  })

  it('refuses background calls without an HTTP request IP so background jobs never burn demo budget', async () => {
    const { deps, counts } = makeDeps(GUEST)
    await expect(assertWithinDemoGuestAiLimit('u-sophie', deps)).rejects.toBeInstanceOf(LlmDailyCapError)
    expect(counts.size).toBe(0)
  })

  it('refuses all AI calls when aiCallsPerIp is set to 0', async () => {
    const { deps } = makeDeps({ ...GUEST, aiCallsPerIp: 0 })
    await runWithRequestAiContext('203.0.113.12', async () => {
      const err = await assertWithinDemoGuestAiLimit('u-sophie', deps).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(LlmDailyCapError)
      expect((err as Error).message).toBe(demoGuestAiLimitMessage(0))
    })
  })
})
