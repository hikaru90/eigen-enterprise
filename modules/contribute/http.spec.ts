import { describe, expect, it } from 'vitest'
import { ContributeError } from './errors'
import { contributeRoute, readJson } from './http'
import { fixture } from './test-fixtures'

const live = async () => fixture().deps

describe('contributeRoute', () => {
  it('401 without a signed-in person', async () => {
    const res = await contributeRoute(null, async () => ({}), live)
    expect(res.status).toBe(401)
  })

  it('maps ContributeError codes to statuses and passes results through as JSON', async () => {
    const codes = { invalid: 400, forbidden: 403, not_found: 404, conflict: 409, upstream: 502 } as const
    for (const [code, status] of Object.entries(codes)) {
      const res = await contributeRoute({ id: 'ana' }, async () => {
        throw new ContributeError(code as keyof typeof codes, `boom ${code}`)
      }, live)
      expect(res.status).toBe(status)
      expect(await res.json()).toEqual({ error: `boom ${code}`, code })
    }
    const ok = await contributeRoute({ id: 'ana' }, async (userId) => ({ userId }), live)
    expect(await ok.json()).toEqual({ userId: 'ana' })
  })

  it('an unexpected error (e.g. no AI provider) is a 500 with its message', async () => {
    const res = await contributeRoute({ id: 'ana' }, async () => {
      throw new Error('No AI provider is set up')
    }, live)
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'No AI provider is set up' })
  })

  it('readJson refuses non-objects', async () => {
    await expect(readJson(new Request('http://x', { method: 'POST', body: '[1]' }))).rejects.toThrow(/JSON object/)
    await expect(readJson(new Request('http://x', { method: 'POST', body: 'nope' }))).rejects.toThrow(/JSON object/)
    expect(await readJson(new Request('http://x', { method: 'POST', body: '{"a":1}' }))).toEqual({ a: 1 })
  })
})
