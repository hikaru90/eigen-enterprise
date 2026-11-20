import { describe, expect, it } from 'vitest'
import { mintViewToken, readViewToken, VIEW_TOKEN_TTL_MS } from './view-token'

const secret = Buffer.alloc(32, 7)
const now = Date.parse('2026-11-20T10:00:00Z')
const scope = { userId: 'alice', folderId: 'f1', fileId: 'p1', fileName: 'index.html' }

describe('drive view tokens (rendered HTML)', () => {
  it('round-trips who may read which folder, until it expires', () => {
    const token = mintViewToken(secret, scope, now)
    expect(readViewToken(secret, token, now + 1000)).toEqual({ ...scope, expiresAt: now + VIEW_TOKEN_TTL_MS })
    expect(readViewToken(secret, token, now + VIEW_TOKEN_TTL_MS + 1)).toBeNull()
  })

  it('a top-level file gets a token for itself only (no folder)', () => {
    const token = mintViewToken(secret, { userId: 'alice', folderId: null, fileId: 'p1', fileName: 'index.html' }, now)
    expect(readViewToken(secret, token, now)).toMatchObject({ folderId: null, fileId: 'p1' })
  })

  it('refuses a token signed with another secret, or changed in any way', () => {
    const token = mintViewToken(secret, scope, now)
    expect(readViewToken(Buffer.alloc(32, 8), token, now)).toBeNull()
    const [body, sig] = token.split('.')
    const forged = Buffer.from(JSON.stringify({ u: 'bob', f: 'f1', p: 'p1', n: 'index.html', e: now + 1e9 })).toString('base64url')
    expect(readViewToken(secret, `${forged}.${sig}`, now)).toBeNull()
    expect(readViewToken(secret, `${body}.${sig}x`, now)).toBeNull()
    expect(readViewToken(secret, 'nonsense', now)).toBeNull()
  })

  it('is safe in a URL path segment', () => {
    expect(mintViewToken(secret, scope, now)).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
  })
})
