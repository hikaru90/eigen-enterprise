import { describe, expect, it, vi } from 'vitest'

const { storage } = vi.hoisted(() => ({ storage: { current: null as unknown } }))
vi.mock('$lib/server/company/live', () => ({ companyStorage: () => storage.current }))

import { memoryCompanyProfileStore } from '$lib/server/company/store'
import { sha256Hex } from '../../../../../../modules/drive/storage'
import { GET } from './+server'

const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1 1"></svg>')
const sha = sha256Hex(svg)

function wire(mime: 'image/svg+xml' | 'image/png' = 'image/svg+xml') {
  const store = memoryCompanyProfileStore({ name: null, logo: { sha256: sha, mime }, updatedBy: 'u', updatedAt: new Date() })
  storage.current = {
    store,
    blobs: { has: async (s: string) => s === sha, get: async () => svg, put: vi.fn(), remove: vi.fn() },
  }
}

const call = (init: { sha?: string; user?: { id: string } | null; apiKey?: boolean; etag?: string } = {}) =>
  GET({
    locals: { user: init.user === undefined ? { id: 'u1' } : init.user, apiKeyAuth: init.apiKey ? { id: 'k' } : undefined },
    params: { sha: init.sha ?? sha },
    request: new Request('http://localhost/api/company/logo/x', { headers: init.etag ? { 'if-none-match': init.etag } : {} }),
  } as never)

describe('GET /api/company/logo/[sha]', () => {
  it('serves the current logo with its type, cached by its name, sandboxed', async () => {
    wire()
    const res = await call()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('image/svg+xml')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
    expect(res.headers.get('content-security-policy')).toContain('sandbox')
    expect(res.headers.get('cache-control')).toBe('private, max-age=31536000, immutable')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(svg)
  })

  it('answers 304 to a matching etag', async () => {
    wire('image/png')
    const res = await call({ etag: `"${sha}"` })
    expect(res.status).toBe(304)
    expect(res.headers.get('content-type')).toBe('image/png')
  })

  it('is for signed-in members only (never an API key)', async () => {
    wire()
    await expect(call({ user: null })).rejects.toMatchObject({ status: 401 })
    await expect(call({ apiKey: true })).rejects.toMatchObject({ status: 401 })
  })

  it('a replaced or unknown logo is not found', async () => {
    wire()
    await expect(call({ sha: 'b'.repeat(64) })).rejects.toMatchObject({ status: 404 })
  })
})
