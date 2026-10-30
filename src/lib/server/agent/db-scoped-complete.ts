import type { GatewayCompleteFn } from './gateway-model'

type CompleteInput = Parameters<GatewayCompleteFn>[0]

/**
 * The production gateway completion for durable turns. pi-durable runs model
 * calls from its own task loop: a turn resumed after a restart (or a
 * background run) has no request, so the request-scoped app DB context that
 * `llmChatCompletion` reads through `getDb()` (BYOK keys, routing, the
 * activity/cost log) is missing. And even with a live request in scope, the
 * loop may be driving ANOTHER user's conversation — so the call always runs
 * inside the attributed user's own RLS session (`input.userId`, resolved from
 * the conversation index), never in whatever context happens to be ambient.
 */
export function createDbScopedComplete(deps: {
  withDbUser: <T>(userId: string, fn: () => Promise<T>) => Promise<T>
  chatCompletion: (input: CompleteInput) => Promise<unknown>
}): GatewayCompleteFn {
  return (input) => deps.withDbUser(input.userId, () => deps.chatCompletion(input))
}

/** Production wiring: lazy imports keep the harness module free of DB/LLM imports at load. */
export const dbScopedGatewayComplete: GatewayCompleteFn = createDbScopedComplete({
  withDbUser: async (userId, fn) => {
    const { withDbUser } = await import('$lib/server/db')
    return withDbUser(userId, () => fn())
  },
  chatCompletion: async (input) => {
    const { llmChatCompletion } = await import('$lib/server/llm/llm-client')
    return llmChatCompletion(input)
  },
})
