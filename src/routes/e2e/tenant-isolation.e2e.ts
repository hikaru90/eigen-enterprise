import { expect, test } from './e2e-test'
import { captureThought, registerUser } from './test-helpers'

test.describe('Tenant isolation (AC-018)', () => {
  test('user A cannot access user B thoughts through search', async ({ browser }) => {
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    await registerUser(contextA, pageA)
    const thought = await captureThought(pageA, 'Secret project Alpha launch date')

    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await registerUser(contextB, pageB)

    const res = await pageB.request.post('/api/retrieval/search', {
      data: { query: 'Alpha launch date', topK: 5 },
    })
    expect(res.ok()).toBeTruthy()
    const body = (await res.json()) as { results: Array<unknown> }
    const ids = body.results.map((r: { id: string }) => r.id)
    expect(ids).not.toContain(thought.id)

    await contextA.close()
    await contextB.close()
  })

  test('user list does not include other users thoughts', async ({ browser }) => {
    const contextA = await browser.newContext()
    const pageA = await contextA.newPage()
    await registerUser(contextA, pageA)
    await captureThought(pageA, 'User A private note')

    const contextB = await browser.newContext()
    const pageB = await contextB.newPage()
    await registerUser(contextB, pageB)
    // Positive control: B's own note comes back, so an empty list cannot pass for isolation.
    const own = await captureThought(pageB, 'User B own note')

    // A JSON-RPC call over the streamable HTTP transport (the MCP SDK wants both
    // Accept types); tool names are namespaced (`memory.retrieve_thoughts`).
    const res = await pageB.request.post('/api/mcp', {
      headers: { accept: 'application/json, text/event-stream' },
      data: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'memory.retrieve_thoughts',
          arguments: { order: 'created_at', top_k: 50 },
        },
      },
    })
    expect(res.ok(), await res.text()).toBeTruthy()
    const body = (await res.json()) as {
      result?: { isError?: boolean; content?: Array<{ text: string }> }
      error?: unknown
    }
    expect(body.error).toBeUndefined()
    expect(body.result?.isError ?? false, body.result?.content?.[0]?.text).toBe(false)
    const result = JSON.parse(body.result?.content?.[0]?.text ?? '{}') as {
      results?: Array<{ id: string; snippet?: string; normalizedText?: string }>
    }
    const thoughts = result.results ?? []
    expect(thoughts.map((t) => t.id)).toContain(own.id)
    for (const t of thoughts) {
      const bodyText = t.normalizedText ?? t.snippet ?? ''
      expect(bodyText).not.toContain('User A private note')
    }

    await contextA.close()
    await contextB.close()
  })
})
