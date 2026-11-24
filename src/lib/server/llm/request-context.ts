import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * Per-HTTP-request AI scope (set in `hooks.server.ts`, preserved into streaming
 * chat turns by `handleAgentChatPost`). Carries the resolved client IP and a
 * per-turn claim flag so one user-initiated AI turn (which may run several
 * internal gateway calls — tool loop + embeddings + final reply) counts as ONE
 * demo AI call for that IP, capped by a hard per-turn raw-call ceiling.
 */
export type RequestAiContext = {
  clientIp: string | null
  demoTurnClaimed: boolean
  demoTurnRawCalls: number
}

export const requestAiContextAsyncLocal = new AsyncLocalStorage<RequestAiContext>()

export function runWithRequestAiContext<T>(clientIp: string | null, fn: () => T): T {
  return requestAiContextAsyncLocal.run(
    { clientIp, demoTurnClaimed: false, demoTurnRawCalls: 0 },
    fn,
  )
}
