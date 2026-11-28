import { describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from './errors'
import type { SlotTarget } from './slots'
import { llmWebSearch, type WebSearchDeps } from './web-search'

function target(pool: 'openrouter' | 'opper' | null): SlotTarget {
  return {
    slot: 'chat',
    source: 'eigeninference',
    config: { provider: pool ? 'platform' : 'eurouter', baseUrl: 'https://x', apiKey: 'k', ruleChat: null, ruleEmbedding: null, modelChat: null, modelEmbedding: null },
    model: pool ? '~deepseek/deepseek-flash-latest' : null,
    pool,
    route: null,
  }
}

const response = {
  choices: [
    {
      message: {
        content: ' Kindred builds websites. ',
        annotations: [
          { type: 'url_citation', url_citation: { url: 'https://kindred.example/', title: 'Kindred', content: 'We build.' } },
          { type: 'url_citation', url_citation: { url: 'https://kindred.example/', title: 'dup' } },
          { type: 'other' },
        ],
      },
    },
  ],
}

describe('llmWebSearch', () => {
  it('searches through the gateway with the web plugin and returns the cited sources', async () => {
    const complete = vi.fn(async () => response)
    const deps: WebSearchDeps = { resolveChat: async () => target('openrouter'), complete }
    const out = await llmWebSearch({ userId: 'u1', query: 'kindred digital labs', maxResults: 50 }, deps)
    expect(out).toEqual({
      answer: 'Kindred builds websites.',
      results: [{ url: 'https://kindred.example/', title: 'Kindred', snippet: 'We build.' }],
    })
    const call = complete.mock.calls[0]![0]
    expect(call.task).toBe('web.search')
    expect(call.plugins).toEqual([{ id: 'web', max_results: 10 }])
  })

  it('fails loud on a provider without web search, before any call', async () => {
    for (const pool of ['opper', null] as const) {
      const complete = vi.fn()
      await expect(llmWebSearch({ userId: 'u1', query: 'q' }, { resolveChat: async () => target(pool), complete })).rejects.toBeInstanceOf(LlmNotConfiguredError)
      expect(complete).not.toHaveBeenCalled()
    }
  })
})
