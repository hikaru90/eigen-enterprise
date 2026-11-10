import { describe, expect, it, vi } from 'vitest'
import { contributeClient } from './client'

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })

describe('contributeClient', () => {
  it('posts JSON to the right routes and unwraps the proposal', async () => {
    const fetchFn = vi.fn(async () => ok({ proposal: { id: 'p1' } }))
    const c = contributeClient(fetchFn)
    expect(await c.share({ title: 't', kind: 'idea', area: 'drive' })).toEqual({ id: 'p1' })
    expect(await c.vote('p 1', 1)).toEqual({ id: 'p1' })
    expect(await c.update('p1', { status: 'shipped' })).toEqual({ id: 'p1' })
    expect(fetchFn.mock.calls.map((call) => [call[0], (call[1] as RequestInit).method, (call[1] as RequestInit).body])).toEqual([
      ['/api/contribute', 'POST', '{"title":"t","kind":"idea","area":"drive"}'],
      ['/api/contribute/p%201/vote', 'POST', '{"direction":1}'],
      ['/api/contribute/p1', 'PATCH', '{"status":"shipped"}'],
    ])
  })

  it('throws the server’s own message', async () => {
    const c = contributeClient(async () => new Response(JSON.stringify({ error: 'No AI provider is set up' }), { status: 500 }))
    await expect(c.check('x')).rejects.toThrow('No AI provider is set up')
    const bare = contributeClient(async () => new Response('nope', { status: 502 }))
    await expect(bare.list()).rejects.toThrow('Request failed (HTTP 502).')
  })
})
