export type TokenUsage = {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  /** OpenRouter: prompt tokens read from (cached_tokens) and written to (cache_write_tokens) the provider's prompt cache. */
  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number }
}

/** The token counts a call's activity row keeps; null where the gateway reported none. */
export type CallTokens = {
  prompt: number | null
  completion: number | null
  cacheRead: number | null
  cacheWrite: number | null
}

const isCount = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0

/**
 * The tokens a gateway response reports (total_tokens, else prompt + completion); 0 when it
 * reports none — a count of what was reported, never an estimate from the text.
 */
export function reportedTokenCount(usage: TokenUsage | undefined): number {
  if (!usage) return 0
  if (isCount(usage.total_tokens)) return usage.total_tokens
  return (isCount(usage.prompt_tokens) ? usage.prompt_tokens : 0) + (isCount(usage.completion_tokens) ? usage.completion_tokens : 0)
}

/** The reported token counts of a gateway response, cache reads and writes included — never estimated. */
export function reportedCallTokens(usage: TokenUsage | undefined): CallTokens {
  const count = (n: unknown) => (isCount(n) ? n : null)
  return {
    prompt: count(usage?.prompt_tokens),
    completion: count(usage?.completion_tokens),
    cacheRead: count(usage?.prompt_tokens_details?.cached_tokens),
    cacheWrite: count(usage?.prompt_tokens_details?.cache_write_tokens),
  }
}

export function parseUsdCost(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed >= 0) return parsed
  }
  return 0
}

/**
 * Provider-reported billable USD from a gateway JSON body (`usage.cost` or top-level `cost`).
 * Returns null when the gateway omitted cost — never inferred from token counts.
 */
export function extractGatewayReportedCostUsd(body: unknown): number | null {
  if (!body || typeof body !== 'object') return null
  const root = body as { usage?: unknown; cost?: unknown }
  const fromRoot = parseUsdCost(root.cost)
  if (fromRoot > 0) return fromRoot
  const usage = root.usage
  if (!usage || typeof usage !== 'object') return null
  const fromUsage = parseUsdCost((usage as { cost?: unknown }).cost)
  if (fromUsage > 0) return fromUsage
  return null
}

/** Platform credits: bill only provider-reported cost; hard-fail when absent. */
export function requireGatewayReportedCostUsd(body: unknown): number {
  const cost = extractGatewayReportedCostUsd(body)
  if (cost === null) {
    throw new Error(
      'LLM gateway response missing usage.cost; platform credits require provider-reported cost (no estimates)',
    )
  }
  return cost
}

/** The response header Opper reports a call's USD cost in (the only place for embeddings and decisions). */
export const OPPER_COST_HEADER = 'x-opper-cost'

/**
 * Activity / transparency logging — reported cost only, zero when the gateway omitted it.
 * The body's cost (`usage.cost` / `cost`) first; else, when the response headers are given,
 * Opper's `x-opper-cost`. Never inferred from tokens.
 */
export function gatewayReportedCostUsdForLog(body: unknown, headers?: Pick<Headers, 'get'> | null): number {
  const fromBody = extractGatewayReportedCostUsd(body)
  if (fromBody !== null) return fromBody
  return parseUsdCost(headers?.get(OPPER_COST_HEADER) ?? undefined)
}
