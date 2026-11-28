import type { AiTaskId } from '$lib/ai-usage/tasks'
import { LlmHttpError } from './errors'

/**
 * Tavily search (https://docs.tavily.com, `POST https://api.tavily.com/search`, Bearer key): the
 * web search eigenInference rents when its provider (Opper) offers none. Basic depth costs one
 * Tavily credit per search; Tavily reports no price per call, so each search is costed at
 * {@link TAVILY_BASIC_SEARCH_USD} (Tavily's pay-as-you-go credit price, $0.008, checked
 * 2026-11-28 — change it here when the hosting's plan changes) and written to the cost ledger
 * like every eigenInference call. The key is never logged.
 */
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search'
export const TAVILY_GATEWAY_HOST = 'api.tavily.com'
/** The `model` a Tavily search's cost row names (search depth basic). */
export const TAVILY_MODEL = 'tavily/search-basic'
/** USD per basic search (1 credit at the pay-as-you-go price). */
export const TAVILY_BASIC_SEARCH_USD = 0.008

const TAVILY_TIMEOUT_MS = 20_000

export type TavilyLogEntry = {
  provider: string
  gatewayHost: string
  operation: string
  task: AiTaskId
  model: string
  baseCostUsd: number
  context: string
  errorMessage?: string
  durationMs: number
  attempt: number
  outcome: 'ok' | 'error'
}

export type TavilyDeps = {
  fetch: typeof fetch
  now: () => number
  logCall: (userId: string, entry: TavilyLogEntry) => Promise<void>
  /** Overridable for tests (fake HTTP server); live = {@link TAVILY_SEARCH_URL}. */
  url?: string
}

export async function tavilySearch(
  input: { userId: string; apiKey: string; query: string; maxResults: number; provider: string },
  deps: TavilyDeps,
): Promise<{ answer: string; results: Array<{ title: string; url: string; snippet: string }> }> {
  const started = deps.now()
  const base = {
    provider: input.provider,
    gatewayHost: TAVILY_GATEWAY_HOST,
    task: 'web.search' as const,
    model: TAVILY_MODEL,
    context: `web.search max_results=${input.maxResults}`,
    attempt: 1,
  }
  try {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(new Error(`Tavily search timed out after ${TAVILY_TIMEOUT_MS}ms`)), TAVILY_TIMEOUT_MS)
    let res: Response
    try {
      res = await deps.fetch(deps.url ?? TAVILY_SEARCH_URL, {
        method: 'POST',
        signal: ac.signal,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${input.apiKey}` },
        body: JSON.stringify({ query: input.query, search_depth: 'basic', max_results: input.maxResults, include_answer: 'basic' }),
      })
    } finally {
      clearTimeout(timer)
    }
    const text = await res.text()
    if (!res.ok) throw new LlmHttpError(res.status, `Tavily search failed: ${text.slice(0, 300)}`)
    const json = parseJson(text)
    const out = parseResponse(json)
    await deps.logCall(input.userId, { ...base, operation: 'web.search.tavily.success', outcome: 'ok', baseCostUsd: TAVILY_BASIC_SEARCH_USD, durationMs: deps.now() - started })
    return out
  } catch (err) {
    await deps.logCall(input.userId, {
      ...base,
      operation: 'web.search.tavily.error',
      outcome: 'error',
      baseCostUsd: 0,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: deps.now() - started,
    })
    throw err
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('The Tavily response is not JSON.')
  }
}

function parseResponse(json: unknown): { answer: string; results: Array<{ title: string; url: string; snippet: string }> } {
  const body = json as { answer?: unknown; results?: unknown }
  if (!Array.isArray(body?.results)) throw new Error('The Tavily response is missing results (array).')
  const seen = new Set<string>()
  const results: Array<{ title: string; url: string; snippet: string }> = []
  for (const r of body.results as Array<{ url?: unknown; title?: unknown; content?: unknown }>) {
    if (typeof r?.url !== 'string' || seen.has(r.url)) continue
    seen.add(r.url)
    results.push({ url: r.url, title: typeof r.title === 'string' ? r.title : '', snippet: typeof r.content === 'string' ? r.content : '' })
  }
  return { answer: typeof body.answer === 'string' ? body.answer.trim() : '', results }
}
