import { describe, expect, it, vi } from 'vitest'
import { inviteScope } from '$lib/server/auth/owner-policy'
import { joinWithInvite } from './accept'
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
