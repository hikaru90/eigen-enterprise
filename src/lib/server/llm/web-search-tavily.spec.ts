import type { SlotTarget } from './slots'
import type { AddressInfo } from 'node:net'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LlmNotConfiguredError } from './errors'
import { readPlatformSearchTavilyKey } from './platform-ai'
import { TAVILY_BASIC_SEARCH_USD, TAVILY_MODEL, type TavilyLogEntry } from './tavily'
import { llmWebSearch, type WebSearchDeps } from './web-search'

const opper: SlotTarget = {
  slot: 'chat',
  source: 'eigeninference',
  config: { provider: 'platform', baseUrl: 'https://api.opper.ai/v3/compat', apiKey: 'sk-OPPER', ruleChat: null, ruleEmbedding: null, modelChat: null, modelEmbedding: null },
  model: '~deepseek/deepseek-flash-latest',
  pool: 'opper',
  route: null,
}

let server: Server | undefined
afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())))

async function fakeTavily(status: number, body: string): Promise<{ url: string; seen: Array<{ auth?: string; body: unknown }> }> {
  const seen: Array<{ auth?: string; body: unknown }> = []
  server = createServer(async (req: IncomingMessage, res) => {
    let raw = ''
    for await (const chunk of req) raw += chunk
    seen.push({ auth: req.headers.authorization, body: JSON.parse(raw) })
    res.writeHead(status, { 'content-type': 'application/json' }).end(body)
  })
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r))
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/search`, seen }
}

function deps(url: string, key: string | null, logs: Array<[string, TavilyLogEntry]>, complete = vi.fn()): WebSearchDeps {
  return {
    resolveChat: async () => opper,
    complete,
    tavilyKey: () => key,
    capCheck: async () => {},
    tavily: { url, fetch: (...a) => fetch(...a), now: () => 1000, logCall: async (u, e) => void logs.push([u, e]) },
  }
}

describe('web.search on eigenInference (Opper) via Tavily', () => {
  it('searches Tavily with the platform key and returns the answer and sources; one billed eigenInference row', async () => {
    const tavily = await fakeTavily(
      200,
      JSON.stringify({
        answer: ' Kindred builds websites. ',
        results: [
          { title: 'Kindred', url: 'https://kindred.example/', content: 'We build.', score: 0.9 },
          { title: 'dup', url: 'https://kindred.example/', content: 'x' },
          { title: 'Blog', url: 'https://kindred.example/blog', content: 'News.' },
        ],
      }),
    )
    const logs: Array<[string, TavilyLogEntry]> = []
    const complete = vi.fn()
    const out = await llmWebSearch({ userId: 'u1', query: ' kindred ', maxResults: 50 }, deps(tavily.url, 'tvly-SECRET', logs, complete))
    expect(out).toEqual({
      answer: 'Kindred builds websites.',
      results: [
        { url: 'https://kindred.example/', title: 'Kindred', snippet: 'We build.' },
        { url: 'https://kindred.example/blog', title: 'Blog', snippet: 'News.' },
      ],
    })
    expect(complete).not.toHaveBeenCalled()
    expect(tavily.seen).toEqual([{ auth: 'Bearer tvly-SECRET', body: { query: 'kindred', search_depth: 'basic', max_results: 10, include_answer: 'basic' } }])
    expect(logs).toHaveLength(1)
    const [user, row] = logs[0]!
    expect(user).toBe('u1')
    expect(row).toMatchObject({ provider: 'platform', task: 'assistant.web_search', model: TAVILY_MODEL, gatewayHost: 'api.tavily.com', outcome: 'ok', baseCostUsd: TAVILY_BASIC_SEARCH_USD })
    expect(JSON.stringify(row)).not.toContain('tvly-SECRET')
  })

  it('a Tavily error fails loud and logs an unbilled error row without the key', async () => {
    const tavily = await fakeTavily(401, JSON.stringify({ detail: { error: 'Unauthorized' } }))
    const logs: Array<[string, TavilyLogEntry]> = []
    await expect(llmWebSearch({ userId: 'u1', query: 'q' }, deps(tavily.url, 'tvly-SECRET', logs))).rejects.toThrow(/Tavily search failed/)
    expect(logs).toHaveLength(1)
    expect(logs[0]![1]).toMatchObject({ outcome: 'error', baseCostUsd: 0, task: 'assistant.web_search' })
    expect(JSON.stringify(logs)).not.toContain('tvly-SECRET')
  })

  it('a response without results fails loud', async () => {
    const tavily = await fakeTavily(200, JSON.stringify({ answer: 'x' }))
    await expect(llmWebSearch({ userId: 'u1', query: 'q' }, deps(tavily.url, 'k', []))).rejects.toThrow(/missing results/)
  })

  it('without the platform key it fails loud before any call', async () => {
    const tavily = await fakeTavily(200, '{}')
    const logs: Array<[string, TavilyLogEntry]> = []
    const err = await llmWebSearch({ userId: 'u1', query: 'q' }, deps(tavily.url, null, logs)).catch((e) => e)
    expect(err).toBeInstanceOf(LlmNotConfiguredError)
    expect(String(err.message)).toContain('PLATFORM_SEARCH_TAVILY_API_KEY')
    expect(tavily.seen).toHaveLength(0)
    expect(logs).toHaveLength(0)
  })

  it('checks the member daily cap before searching', async () => {
    const tavily = await fakeTavily(200, '{"results":[]}')
    const d = deps(tavily.url, 'k', [])
    d.capCheck = async () => {
      throw new Error('cap reached')
    }
    await expect(llmWebSearch({ userId: 'u1', query: 'q' }, d)).rejects.toThrow('cap reached')
    expect(tavily.seen).toHaveLength(0)
  })
})

describe('readPlatformSearchTavilyKey', () => {
  it('present or absent, never a default', () => {
    expect(readPlatformSearchTavilyKey({})).toBeNull()
    expect(readPlatformSearchTavilyKey({ PLATFORM_SEARCH_TAVILY_API_KEY: '  ' })).toBeNull()
    expect(readPlatformSearchTavilyKey({ PLATFORM_SEARCH_TAVILY_API_KEY: ' tvly-1 ' })).toBe('tvly-1')
  })
})
