import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { ownerLinkConfigFromEnv, ownerLinkStatus, signInWithOwnerLink } from './owner-link'

const token = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const hash = createHash('sha256').update(token).digest('hex')
const future = new Date(Date.now() + 3600_000)

function deps(over: Partial<Parameters<typeof signInWithOwnerLink>[1]> = {}) {
  const consumed = new Set<string>()
  return {
    config: { tokenHash: hash, expiresAt: future },
    ownerEmail: async () => 'owner@kindred.test',
    isConsumed: async (h: string) => consumed.has(h),
    consume: async (h: string) => (consumed.has(h) ? false : (consumed.add(h), true)),
    createCode: vi.fn(async () => '123456'),
    signIn: vi.fn(async () => {}),
    ...over,
  }
}

describe('ownerLinkConfigFromEnv', () => {
  it('reads the hash + expiry ee set; none means no link', () => {
    expect(ownerLinkConfigFromEnv({})).toBeNull()
    expect(ownerLinkConfigFromEnv({ EE_OWNER_LINK_HASH: hash, EE_OWNER_LINK_EXPIRES_AT: future.toISOString() })).toEqual({ tokenHash: hash, expiresAt: future })
  })
  it('fails loud on a half-configured link, naming its own variables', () => {
    expect(() => ownerLinkConfigFromEnv({ EE_OWNER_LINK_HASH: hash })).toThrow(/EE_OWNER_LINK_EXPIRES_AT/)
  })
})

describe('signInWithOwnerLink', () => {
  it('signs the owner in with a code that is never sent, and the link works once', async () => {
    const d = deps()
    expect(await signInWithOwnerLink(token, d)).toBe('owner@kindred.test')
    expect(d.createCode).toHaveBeenCalledWith('owner@kindred.test')
    expect(d.signIn).toHaveBeenCalledWith('owner@kindred.test', '123456')
    expect(await ownerLinkStatus(token, d)).toBe('used')
    await expect(signInWithOwnerLink(token, d)).rejects.toMatchObject({ code: 'used' })
    expect(d.signIn).toHaveBeenCalledOnce()
  })

  it.each([
    ['no link on this server', { config: null }, token, 'no_link'],
    ['wrong token', {}, 'nope', 'invalid_token'],
    ['expired', { config: { tokenHash: hash, expiresAt: new Date(Date.now() - 1000) } }, token, 'expired'],
    ['nobody owns the company', { ownerEmail: async () => null }, token, 'no_owner'],
  ] as const)('refuses: %s', async (_l, over, tok, code) => {
    const d = deps(over as never)
    await expect(signInWithOwnerLink(tok, d)).rejects.toMatchObject({ code })
    expect(d.signIn).not.toHaveBeenCalled()
  })

  it('a racing second use loses at consume time and never signs in', async () => {
    const d = deps({ consume: async () => false })
    await expect(signInWithOwnerLink(token, d)).rejects.toMatchObject({ code: 'used' })
    expect(d.signIn).not.toHaveBeenCalled()
  })
})
