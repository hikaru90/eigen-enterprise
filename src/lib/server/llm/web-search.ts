import type { ChatMessage } from './llm-client'
import { LlmNotConfiguredError } from './errors'
import type { SlotTarget } from './slots'

/**
 * Web search for the assistant and co-workers (wish 133f8e82), through the gateway: OpenRouter's
 * web plugin (`plugins: [{ id: 'web' }]`) on the company's chat model, so the search's price comes
 * back in the call's `usage.cost` and lands on the cost ledger (task `web.search`). Opper and
 * providers outside the pool offer no web search: the call fails loud (LlmNotConfiguredError),
 * naming what to switch on, never a silent empty result.
 */

export type WebSearchResult = { title: string; url: string; snippet: string }

export type WebSearchDeps = {
  resolveChat: (userId: string) => Promise<SlotTarget>
  complete: (input: {
    userId: string
    messages: ChatMessage[]
    maxTokens?: number
    temperature?: number
    task: 'web.search'
    plugins: unknown[]
  }) => Promise<unknown>
}

/** Live calls run on the company's provider (company-provider.ts), whoever the caller is. */
async function onCompany<T>(fn: () => Promise<T>): Promise<T> {
  const { onCompanyProvider } = await import('./company-provider')
  return onCompanyProvider(fn)
}

export const liveWebSearchDeps: WebSearchDeps = {
  resolveChat: (userId) => onCompany(async () => (await import('./slots')).resolveSlot('chat', userId)),
  complete: (input) => onCompany(async () => (await import('./llm-client')).llmChatCompletion(input)),
}

export const WEB_SEARCH_MAX_RESULTS = 10

const SEARCH_INSTRUCTIONS =
  'Search the web for the query. Answer in a few sentences from the results only, and cite each source you use.'

type Annotation = { type?: unknown; url_citation?: { url?: unknown; title?: unknown; content?: unknown } }

export async function llmWebSearch(
  input: { userId: string; query: string; maxResults?: number },
  deps: WebSearchDeps = liveWebSearchDeps,
): Promise<{ answer: string; results: WebSearchResult[] }> {
  const query = input.query.trim()
  if (!query) throw new Error('A web search needs a query.')
  const maxResults = Math.min(Math.max(input.maxResults ?? 5, 1), WEB_SEARCH_MAX_RESULTS)
  const target = await deps.resolveChat(input.userId)
  if (target.pool !== 'openrouter') {
    const on = target.pool === 'opper' ? 'eigenInference on Opper' : target.config.provider
    throw new LlmNotConfiguredError(
      `Web search runs through OpenRouter's web search, and this company's AI runs on ${on}, which offers none. Switch to eigenInference on OpenRouter or the company's own OpenRouter key under Settings → AI.`,
    )
  }
  const response = await deps.complete({
    userId: input.userId,
    messages: [
      { role: 'system', content: SEARCH_INSTRUCTIONS },
      { role: 'user', content: query },
    ],
    temperature: 0,
    maxTokens: 1_500,
    task: 'web.search',
    plugins: [{ id: 'web', max_results: maxResults }],
  })
  const message = (response as { choices?: Array<{ message?: { content?: unknown; annotations?: unknown } }> })?.choices?.[0]?.message
  if (typeof message?.content !== 'string') throw new Error('gateway response is missing choices[0].message.content (string)')
  const annotations = Array.isArray(message.annotations) ? (message.annotations as Annotation[]) : []
  const seen = new Set<string>()
  const results: WebSearchResult[] = []
  for (const a of annotations) {
    const c = a.type === 'url_citation' ? a.url_citation : undefined
    if (!c || typeof c.url !== 'string' || seen.has(c.url)) continue
    seen.add(c.url)
    results.push({
      url: c.url,
      title: typeof c.title === 'string' ? c.title : '',
      snippet: typeof c.content === 'string' ? c.content : '',
    })
  }
  return { answer: message.content.trim(), results }
}
