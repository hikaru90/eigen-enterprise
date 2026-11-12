import { describe, expect, it, vi } from 'vitest'

const { roleMock } = vi.hoisted(() => ({ roleMock: vi.fn(async (): Promise<string | null> => 'member') }))
vi.mock('$lib/server/auth/user-role', () => ({ getUserRole: roleMock }))

import { capabilitiesFor, roleCan } from './capabilities'
import { requireCapability, userCapabilities } from './require-capability'

describe('capabilitiesFor (one set, from the role)', () => {
  it('the owner holds every capability', () => {
    expect(Object.values(capabilitiesFor('owner')).every(Boolean)).toBe(true)
  })

  it('an admin holds everything but Backups (the owner’s alone)', () => {
    expect(capabilitiesFor('admin')).toEqual({
      'company.manage': true,
      'members.manage': true,
      'approvals.manage': true,
      'backups.manage': false,
      'modules.manage': true,
      'website.manage': true,
      'brand.extract': true,
    })
  })

  it('a member holds none of them', () => {
    expect(Object.values(capabilitiesFor('member')).some(Boolean)).toBe(false)
  })

  it('fails closed without a role', () => {
    expect(Object.values(capabilitiesFor(null)).some(Boolean)).toBe(false)
  })

  it('roleCan answers one capability the same way', () => {
    expect(roleCan('admin', 'company.manage')).toBe(true)
    expect(roleCan('member', 'company.manage')).toBe(false)
    expect(roleCan('admin', 'backups.manage')).toBe(false)
  })
})

describe('userCapabilities', () => {
  it('reads the role of the signed-in person', async () => {
    roleMock.mockResolvedValueOnce('admin')
    expect((await userCapabilities('u1'))['company.manage']).toBe(true)
    expect(roleMock).toHaveBeenCalledWith('u1')
  })
})

describe('requireCapability (the route guard)', () => {
  const locals = (user: { id: string } | null) => ({ user }) as unknown as App.Locals

  it('sends signed-out visitors to sign in', async () => {
    await expect(requireCapability(locals(null), 'company.manage', 'nope')).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('answers 403 with the reason without the capability', async () => {
    roleMock.mockResolvedValueOnce('member')
    await expect(requireCapability(locals({ id: 'm' }), 'company.manage', 'Only admins.')).rejects.toMatchObject({
      status: 403,
      body: { message: 'Only admins.' },
    })
  })

  it('returns the person and role with it', async () => {
    roleMock.mockResolvedValueOnce('owner')
    expect(await requireCapability(locals({ id: 'o' }), 'backups.manage', 'x')).toEqual({
      user: { id: 'o' },
      role: 'owner',
    })
  })
})
