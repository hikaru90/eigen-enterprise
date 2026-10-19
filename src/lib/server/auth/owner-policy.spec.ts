import { describe, expect, it } from 'vitest'
import { ownerPolicyForNewUser } from './owner-policy'

describe('ownerPolicyForNewUser (single-tenant: the company has one owner)', () => {
  it('on an ee server, only the claim link creates the first account, and it becomes the owner', () => {
    expect(ownerPolicyForNewUser({ existingUsers: 0, managedByEe: true, viaClaim: true })).toEqual({ role: 'admin' })
    expect(() => ownerPolicyForNewUser({ existingUsers: 0, managedByEe: true, viaClaim: false })).toThrow(/not been claimed/)
  })

  it('on an ee server, signup closes once the owner exists (claim links too)', () => {
    expect(() => ownerPolicyForNewUser({ existingUsers: 1, managedByEe: true, viaClaim: false })).toThrow(/already has an owner/)
    expect(() => ownerPolicyForNewUser({ existingUsers: 1, managedByEe: true, viaClaim: true })).toThrow(/already has an owner/)
  })

  it('outside ee (dev, tests) the first signup is the owner, later ones are users', () => {
    expect(ownerPolicyForNewUser({ existingUsers: 0, managedByEe: false, viaClaim: false })).toEqual({ role: 'admin' })
    expect(ownerPolicyForNewUser({ existingUsers: 3, managedByEe: false, viaClaim: false })).toEqual({ role: 'user' })
  })
})
