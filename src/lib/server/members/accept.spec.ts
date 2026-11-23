import { describe, expect, it, vi } from 'vitest'
import { inviteScope } from '$lib/server/auth/owner-policy'
import { createInvitedAccount, joinWithInvite } from './accept'
import { hashInviteToken } from './service'
import { memoryStore } from './memory-store'

const now = new Date('2026-10-21T10:00:00Z')

function setup(over: Partial<{ acceptedAt: Date | null; expiresAt: Date }> = {}) {
  const store = memoryStore()
  store.invites.push({
    id: 'inv1',
    email: 'new@k.co',
    role: 'admin',
    tokenHash: hashInviteToken('tok'),
    invitedBy: 'o',
    expiresAt: new Date('2026-10-28T10:00:00Z'),
    acceptedAt: null,
    createdAt: now,
    ...over,
  })
  const seen: unknown[] = []
  const deps = {
    store,
    now: () => now,
    createCode: vi.fn(async () => '424242'),
    signIn: vi.fn(async () => {
      seen.push(inviteScope.getStore())
    }),
  }
  return { store, deps, seen }
}

describe('joining with an invite link (no email needed)', () => {
  it('mints a code server-side for the invited address and signs in inside the invite scope', async () => {
    const { deps, seen } = setup()
    expect(await joinWithInvite('tok', { name: ' Bea ' }, deps)).toEqual({ email: 'new@k.co' })
    expect(deps.createCode).toHaveBeenCalledWith('new@k.co')
    expect(deps.signIn).toHaveBeenCalledWith('new@k.co', '424242', 'Bea')
    expect(seen).toEqual([{ inviteId: 'inv1', email: 'new@k.co', role: 'admin' }])
  })

  it('refuses expired, used and unknown links before any code is minted', async () => {
    for (const [over, msg] of [
      [{ expiresAt: new Date('2026-10-20T00:00:00Z') }, /expired/],
      [{ acceptedAt: now }, /already used/],
    ] as const) {
      const { deps } = setup(over)
      await expect(joinWithInvite('tok', { name: 'B' }, deps)).rejects.toThrow(msg)
      expect(deps.createCode).not.toHaveBeenCalled()
      expect(deps.signIn).not.toHaveBeenCalled()
    }
    const { deps } = setup()
    await expect(joinWithInvite('other', { name: 'B' }, deps)).rejects.toThrow(/not valid/)
    expect(deps.createCode).not.toHaveBeenCalled()
  })

  it('needs a name', async () => {
    const { deps } = setup()
    await expect(joinWithInvite('tok', { name: '  ' }, deps)).rejects.toThrow(/Enter your name/)
    expect(deps.createCode).not.toHaveBeenCalled()
  })
})

describe('creating the invited account without a sign-in (server-side, no browser: the demo seed)', () => {
  it('creates the account for the invited address inside the invite scope; no code is minted, nobody is signed in', async () => {
    const { store, deps } = setup()
    const seen: unknown[] = []
    const createAccount = vi.fn(async () => {
      seen.push(inviteScope.getStore())
    })
    expect(await createInvitedAccount('tok', { name: ' Bea ' }, { store, now: deps.now, createAccount })).toEqual({
      email: 'new@k.co',
    })
    expect(createAccount).toHaveBeenCalledWith('new@k.co', 'Bea')
    expect(seen).toEqual([{ inviteId: 'inv1', email: 'new@k.co', role: 'admin' }])
  })

  it('refuses the same links joining refuses, before any account is made', async () => {
    const { store, deps } = setup({ acceptedAt: now })
    const createAccount = vi.fn(async () => {})
    await expect(createInvitedAccount('tok', { name: 'B' }, { store, now: deps.now, createAccount })).rejects.toThrow(
      /already used/,
    )
    await expect(createInvitedAccount('other', { name: 'B' }, { store, now: deps.now, createAccount })).rejects.toThrow(
      /not valid/,
    )
    await expect(createInvitedAccount('tok', { name: ' ' }, { store, now: deps.now, createAccount })).rejects.toThrow(
      /Enter your name/,
    )
    expect(createAccount).not.toHaveBeenCalled()
  })
})
