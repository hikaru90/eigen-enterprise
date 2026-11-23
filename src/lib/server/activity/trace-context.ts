import { AsyncLocalStorage } from 'node:async_hooks'

/**
 * One trace = one unit of work whose model calls belong together (a chat turn, a capture):
 * the gateway tags each cost-log row with the trace's group id (log-call.ts), and adds the
 * tokens each chat completion reported to the trace's running count (in process only — the
 * cost log has no token column), so the caller can say what the work cost.
 */
type TraceStore = { groupId: string; tokens: number }

export const traceStorage = new AsyncLocalStorage<TraceStore>()

export function runWithTrace<T>(groupId: string, fn: () => Promise<T>): Promise<T> {
  return traceStorage.run({ groupId, tokens: 0 }, fn)
}

export function getCurrentTraceGroupId(): string | undefined {
  return traceStorage.getStore()?.groupId
}

/** Add a model call's reported tokens to the current trace (no trace: nothing to count into). */
export function addTraceTokens(tokens: number): void {
  if (!Number.isInteger(tokens) || tokens < 0) {
    throw new Error(`A model call's token count must be a non-negative integer, got ${tokens}`)
  }
  const store = traceStorage.getStore()
  if (store) store.tokens += tokens
}

/** The tokens counted into the current trace so far; outside a trace there is none to read. */
export function currentTraceTokens(): number {
  const store = traceStorage.getStore()
  if (!store) throw new Error('currentTraceTokens() was called outside runWithTrace')
  return store.tokens
}
