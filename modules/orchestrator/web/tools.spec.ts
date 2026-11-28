import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '$lib/kernel/types'
import { LlmNotConfiguredError } from '$lib/server/llm/errors'
import { WebFetchError, type FetchedPage } from '$lib/server/web/fetch-page'
import { createWebTools, WEB_FETCH_MAX_CHARS, type WebToolPorts } from './tools'

const ctx = { principal: { id: 'cw1', kind: 'coworker', roles: ['member'], agentId: 'a1' }, requestId: 'r' } as unknown as ToolContext
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2])

function page(over: Partial<FetchedPage>): FetchedPage {
  return { url: 'https://kindred.example/', status: 200, contentType: 'text/html', body: Buffer.from(''), truncated: false, ...over }
}

function tools(p: Partial<WebToolPorts>) {
  const ports: WebToolPorts = {
    fetch: vi.fn(async () => page({})),
    lookAt: vi.fn(async () => ({ text: 'A logo.', model: 'google/gemini-3.8-flash' })),
    search: vi.fn(async () => ({ answer: 'a', results: [] })),
    ...p,
  }
  const [fetchTool, searchTool] = createWebTools({ ports: async () => ports })
  return { fetchTool: fetchTool!, searchTool: searchTool!, ports }
}

describe('web tools', () => {
  it('are reads that co-workers (role member), admins and agents get', () => {
    const { fetchTool, searchTool } = tools({})
    for (const t of [fetchTool, searchTool]) {
      expect(t.auditClass).toBe('read')
      expect(t.permission.roles).toEqual(expect.arrayContaining(['member', 'admin', 'agent']))
    }
    expect([fetchTool.name, searchTool.name]).toEqual(['web.fetch', 'web.search'])
  })

  it('web.fetch returns a page as title + readable text', async () => {
    const { fetchTool } = tools({ fetch: vi.fn(async () => page({ body: Buffer.from('<title>Kindred</title><p>Hello <a href="/x">there</a></p>') })) })
    expect(await fetchTool.handler(ctx, { url: 'https://kindred.example/' })).toEqual({
      url: 'https://kindred.example/',
      status: 200,
      content_type: 'text/html',
      kind: 'html',
      title: 'Kindred',
      text: 'Hello there (https://kindred.example/x)',
      truncated: false,
    })
  })

  it('web.fetch cuts long text and says so', async () => {
    const { fetchTool } = tools({ fetch: vi.fn(async () => page({ contentType: 'text/plain', body: Buffer.from('y'.repeat(WEB_FETCH_MAX_CHARS + 5)) })) })
    const out = (await fetchTool.handler(ctx, { url: 'https://kindred.example/a.txt' })) as { text: string; truncated: boolean }
    expect(out.text.length).toBe(WEB_FETCH_MAX_CHARS)
    expect(out.truncated).toBe(true)
  })

  it('web.fetch hands an image to the vision model as the caller, under web.image_read', async () => {
    const { fetchTool, ports } = tools({ fetch: vi.fn(async () => page({ url: 'https://kindred.example/logo.png', contentType: 'image/png', body: PNG })) })
    const out = await fetchTool.handler(ctx, { url: 'https://kindred.example/logo.png', question: 'colour?' })
    expect(out).toMatchObject({ kind: 'image', title: 'logo.png', text: 'A logo.' })
    expect(ports.lookAt).toHaveBeenCalledWith({
      userId: 'cw1',
      task: 'web.image_read',
      name: 'logo.png',
      attachment: { type: 'image', mime: 'image/png', base64: PNG.toString('base64') },
      question: 'colour?',
    })
  })

  it('web.fetch refuses blocked addresses and unknown types with the reason', async () => {
    const blocked = tools({ fetch: vi.fn(async () => Promise.reject(new WebFetchError('blocked_address', '10.0.0.1 is not on the public internet'))) })
    await expect(blocked.fetchTool.handler(ctx, { url: 'http://10.0.0.1/' })).rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('public internet') })
    const zip = tools({ fetch: vi.fn(async () => page({ contentType: 'application/zip', body: Buffer.from('PK') })) })
    await expect(zip.fetchTool.handler(ctx, { url: 'https://x.example/a.zip' })).rejects.toMatchObject({ code: 'invalid_input' })
  })

  it('web.search searches as the caller; a provider without search says so', async () => {
    const ok = tools({})
    await ok.searchTool.handler(ctx, { query: 'kindred', max_results: 3 })
    expect(ok.ports.search).toHaveBeenCalledWith({ userId: 'cw1', query: 'kindred', maxResults: 3 })
    const none = tools({ search: vi.fn(async () => Promise.reject(new LlmNotConfiguredError('no web search on Opper'))) })
    await expect(none.searchTool.handler(ctx, { query: 'q' })).rejects.toMatchObject({ code: 'not_configured' })
  })
})
