import {
  hashClientIp,
  MAX_RAW_GATEWAY_CALLS_PER_DEMO_TURN,
  utcDayKey,
  type ActiveDemoGuest,
} from '$lib/server/demo/guest-access'
import { demoGuestAiLimitMessage, LlmDailyCapError } from './errors'
import { requestAiContextAsyncLocal, type RequestAiContext } from './request-context'

/**
 * Per-IP daily AI turn limit for the shared login-free demo guest account
 * (plan/phase-demo-company.md).
 *
 * When a gateway call runs for the active shared demo teammate:
 *  - `aiCallsPerIp === 0` → refuse every AI call.
 *  - No HTTP request context / no client IP (e.g. background memory enrichment
 *    or co-worker event routing triggered by a demo visitor's edits) → refuse
 *    so background jobs never silently burn AI budget on behalf of visitors.
 *  - Within an HTTP request: the first gateway call claims 1 turn atomically
 *    against `(sha256(ip), utcDay)` up to `aiCallsPerIp`; follow-up gateway
 *    calls in the same turn (e.g. tool loop + embedding + final answer) share
 *    that claimed turn up to `MAX_RAW_GATEWAY_CALLS_PER_DEMO_TURN`.
 */

export type DemoGuestAiLimitDeps = {
  activeDemoGuest(): Promise<ActiveDemoGuest | null>
  claimCall(ipHash: string, dayUtc: string, limit: number): Promise<{ allowed: boolean; used: number }>
  requestContext(): RequestAiContext | undefined
  now(): Date
}

export async function assertWithinDemoGuestAiLimit(
  userId: string,
  deps: DemoGuestAiLimitDeps,
): Promise<void> {
  const active = await deps.activeDemoGuest()
  if (!active || active.userId !== userId) return

  const limit = active.aiCallsPerIp
  const limitError = () =>
    new LlmDailyCapError({
      capUsd: 0,
      spentUsd: 0,
      message: demoGuestAiLimitMessage(limit),
    })

  if (limit <= 0) throw limitError()

  const ctx = deps.requestContext()
  const clientIp = ctx?.clientIp?.trim()
  if (!ctx || !clientIp) throw limitError()

  if (ctx.demoTurnClaimed) {
    if (ctx.demoTurnRawCalls >= MAX_RAW_GATEWAY_CALLS_PER_DEMO_TURN) throw limitError()
    ctx.demoTurnRawCalls += 1
    return
  }

  const { allowed } = await deps.claimCall(hashClientIp(clientIp), utcDayKey(deps.now()), limit)
  if (!allowed) throw limitError()

  ctx.demoTurnClaimed = true
  ctx.demoTurnRawCalls = 1
}

export function liveDemoGuestAiLimitDeps(store: {
  activeDemoGuest(): Promise<ActiveDemoGuest | null>
  claimCall(ipHash: string, dayUtc: string, limit: number): Promise<{ allowed: boolean; used: number }>
}): DemoGuestAiLimitDeps {
  return {
    activeDemoGuest: () => store.activeDemoGuest(),
    claimCall: (ipHash, dayUtc, limit) => store.claimCall(ipHash, dayUtc, limit),
    requestContext: () => requestAiContextAsyncLocal.getStore(),
    now: () => new Date(),
  }
}
