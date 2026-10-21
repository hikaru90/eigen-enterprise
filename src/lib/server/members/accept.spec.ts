import { describe, expect, it, vi } from 'vitest'
import { inviteScope } from '$lib/server/auth/owner-policy'
import { acceptInvite, sendInviteCode } from './accept'
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
    sendCode: vi.fn(async () => {}),
    signIn: vi.fn(async () => {
      seen.push(inviteScope.getStore())
    }),
  }
  return { store, deps, seen }
}

describe('accepting an invite', () => {
  it('sends the code to the invited address only, then signs in inside the invite scope', async () => {
    const { deps, seen } = setup()
    expect(await sendInviteCode('tok', deps)).toEqual({ email: 'new@k.co' })
    expect(deps.sendCode).toHaveBeenCalledWith('new@k.co')
    await acceptInvite('tok', '123456', deps)
    expect(deps.signIn).toHaveBeenCalledWith('new@k.co', '123456')
    expect(seen).toEqual([{ inviteId: 'inv1', email: 'new@k.co', role: 'admin' }])
  })

  it('refuses expired, used and unknown links before any code is sent', async () => {
    for (const [over, msg] of [
      [{ expiresAt: new Date('2026-10-20T00:00:00Z') }, /expired/],
      [{ acceptedAt: now }, /already used/],
    ] as const) {
      const { deps } = setup(over)
      await expect(sendInviteCode('tok', deps)).rejects.toThrow(msg)
      await expect(acceptInvite('tok', '1', deps)).rejects.toThrow(msg)
      expect(deps.sendCode).not.toHaveBeenCalled()
      expect(deps.signIn).not.toHaveBeenCalled()
    }
    const { deps } = setup()
    await expect(sendInviteCode('other', deps)).rejects.toThrow(/not valid/)
  })
})
