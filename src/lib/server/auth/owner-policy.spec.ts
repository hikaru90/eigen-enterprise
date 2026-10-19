import { describe, expect, it } from 'vitest'
import { ownerPolicyForNewUser } from './owner-policy'

describe('ownerPolicyForNewUser (single-tenant: the company has one owner)', () => {
  it('the first human to sign up owns the company (admin)', () => {
    expect(ownerPolicyForNewUser({ existingUsers: 0, managedByEe: true })).toEqual({ role: 'admin' })
    expect(ownerPolicyForNewUser({ existingUsers: 0, managedByEe: false })).toEqual({ role: 'admin' })
  })

  it('on an ee-managed server, signup closes once the owner exists', () => {
    expect(() => ownerPolicyForNewUser({ existingUsers: 1, managedByEe: true })).toThrow(/already has an owner/)
  })

  it('outside ee (dev, tests) later signups stay ordinary users', () => {
    expect(ownerPolicyForNewUser({ existingUsers: 3, managedByEe: false })).toEqual({ role: 'user' })
  })
})
