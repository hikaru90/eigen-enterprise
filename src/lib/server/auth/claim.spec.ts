import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { checkClaimToken, claimCompany, claimConfigFromEnv, ClaimError } from './claim'
import { claimScope } from './owner-policy'

const token = 'tok_abcdefghijklmnopqrstuvwxyz0123456789'
const hash = createHash('sha256').update(token).digest('hex')
const future = new Date(Date.now() + 3600_000).toISOString()

describe('claimConfigFromEnv', () => {
  it('reads the hash + expiry ee set; none means this server has no claim link', () => {
    expect(claimConfigFromEnv({})).toBeNull()
    expect(claimConfigFromEnv({ EE_CLAIM_TOKEN_HASH: hash, EE_CLAIM_EXPIRES_AT: future })).toEqual({ tokenHash: hash, expiresAt: new Date(future) })
  })
  it('fails loud on a half-configured claim', () => {
    expect(() => claimConfigFromEnv({ EE_CLAIM_TOKEN_HASH: hash })).toThrow(/EE_CLAIM_EXPIRES_AT/)
    expect(() => claimConfigFromEnv({ EE_CLAIM_TOKEN_HASH: hash, EE_CLAIM_EXPIRES_AT: 'nope' })).toThrow(/not a date/)
  })
})

describe('checkClaimToken', () => {
  const cfg = { tokenHash: hash, expiresAt: new Date(future) }
  it('accepts the right token before expiry only', () => {
    expect(checkClaimToken(token, cfg, new Date())).toBe('ok')
    expect(checkClaimToken(token + 'x', cfg, new Date())).toBe('invalid')
    expect(checkClaimToken('', cfg, new Date())).toBe('invalid')
    expect(checkClaimToken(token, cfg, new Date(Date.now() + 7200_000))).toBe('expired')
  })
})

describe('claimCompany', () => {
  const config = { tokenHash: hash, expiresAt: new Date(future) }

  it('mints a sign-in code without sending it and signs the claimer in, inside the claim scope', async () => {
    const seenScope: Array<true | undefined> = []
    const deps = {
      config,
      countUsers: async () => 0,
      createCode: vi.fn(async () => '123456'),
      signIn: vi.fn(async () => {
        seenScope.push(claimScope.getStore())
      }),
    }
    await claimCompany({ email: 'Owner@Kindred.Test', token }, deps)
    expect(deps.createCode).toHaveBeenCalledWith('owner@kindred.test')
    expect(deps.signIn).toHaveBeenCalledWith('owner@kindred.test', '123456')
    expect(seenScope).toEqual([true]) // the user-create hook sees viaClaim
  })

  it.each([
    ['no claim link on this server', null, 0, token, 'no_claim'],
    ['already claimed', config, 1, token, 'already_claimed'],
    ['wrong token', config, 0, 'nope', 'invalid_token'],
  ] as const)('refuses: %s', async (_l, cfg, users, tok, code) => {
    const signIn = vi.fn()
    await expect(
      claimCompany({ email: 'a@b.co', token: tok }, { config: cfg, countUsers: async () => users, createCode: async () => '1', signIn }),
    ).rejects.toMatchObject({ code })
    expect(signIn).not.toHaveBeenCalled()
  })

  it('rejects an invalid email before anything happens', async () => {
    await expect(
      claimCompany({ email: 'not-an-email', token }, { config, countUsers: async () => 0, createCode: async () => '1', signIn: vi.fn() }),
    ).rejects.toBeInstanceOf(ClaimError)
  })
})
