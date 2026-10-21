import { createHash } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { checkClaimToken, claimCompany, claimConfigFromEnv, ClaimError, claimMessage, claimStatus } from './claim'
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
    const consumed = new Set<string>()
    const deps = {
      config,
      countUsers: async () => 0,
      isConsumed: async (h: string) => consumed.has(h),
      consume: async (h: string) => (consumed.has(h) ? false : (consumed.add(h), true)),
      createCode: vi.fn(async () => '123456'),
      signIn: vi.fn(async () => {
        seenScope.push(claimScope.getStore())
      }),
    }
    await claimCompany({ email: 'Owner@Kindred.Test', token }, deps)
    expect(deps.createCode).toHaveBeenCalledWith('owner@kindred.test')
    expect(deps.signIn).toHaveBeenCalledWith('owner@kindred.test', '123456')
    expect(seenScope).toEqual([true]) // the user-create hook sees viaClaim
    // The token is spent: the same link is refused afterwards, even before any account shows up.
    expect(await claimStatus(token, deps)).toBe('already_claimed')
    await expect(claimCompany({ email: 'second@kindred.test', token }, deps)).rejects.toMatchObject({ code: 'already_claimed' })
    expect(deps.signIn).toHaveBeenCalledOnce()
  })

  it('once an owner exists, a still-valid token is refused with plain words', async () => {
    const status = await claimStatus(token, { config, countUsers: async () => 1, isConsumed: async () => false })
    expect(status).toBe('already_claimed')
    expect(claimMessage(status as 'already_claimed')).toBe('This company already has an owner.')
  })

  it('a racing second claim loses at consume time and never signs in', async () => {
    const signIn = vi.fn()
    await expect(
      claimCompany(
        { email: 'a@b.co', token },
        { config, countUsers: async () => 0, isConsumed: async () => false, consume: async () => false, createCode: async () => '1', signIn },
      ),
    ).rejects.toMatchObject({ code: 'already_claimed' })
    expect(signIn).not.toHaveBeenCalled()
  })

  it.each([
    ['no claim link on this server', null, 0, token, 'no_claim'],
    ['already claimed', config, 1, token, 'already_claimed'],
    ['wrong token', config, 0, 'nope', 'invalid_token'],
  ] as const)('refuses: %s', async (_l, cfg, users, tok, code) => {
    const signIn = vi.fn()
    await expect(
      claimCompany(
        { email: 'a@b.co', token: tok },
        { config: cfg, countUsers: async () => users, isConsumed: async () => false, consume: async () => true, createCode: async () => '1', signIn },
      ),
    ).rejects.toMatchObject({ code })
    expect(signIn).not.toHaveBeenCalled()
  })

  it('rejects an invalid email before anything happens', async () => {
    await expect(
      claimCompany(
        { email: 'not-an-email', token },
        { config, countUsers: async () => 0, isConsumed: async () => false, consume: async () => true, createCode: async () => '1', signIn: vi.fn() },
      ),
    ).rejects.toBeInstanceOf(ClaimError)
  })
})
