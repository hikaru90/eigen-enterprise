import { describe, expect, it } from 'vitest'
import { notAMemberMessage, ownerPolicyForNewUser, signInGate } from './owner-policy'

const base = { invite: null, viaClaim: false }

describe('ownerPolicyForNewUser (single-tenant: the company has one owner)', () => {
  it('on an ee server, only the claim link creates the first account, and it becomes the owner', () => {
    expect(ownerPolicyForNewUser({ ...base, existingUsers: 0, managedByEe: true, viaClaim: true })).toEqual({ role: 'owner' })
    expect(() => ownerPolicyForNewUser({ ...base, existingUsers: 0, managedByEe: true })).toThrow(/not been claimed/)
  })

  it('on an ee server, once the owner exists nobody signs up on their own, and a claim never makes a second owner', () => {
    expect(() => ownerPolicyForNewUser({ ...base, existingUsers: 1, managedByEe: true })).toThrow(/not a member/)
    expect(() => ownerPolicyForNewUser({ ...base, existingUsers: 1, managedByEe: true, viaClaim: true })).toThrow(/already has an owner/)
  })

  it('an accepted invite creates the account with the invited role', () => {
    expect(ownerPolicyForNewUser({ ...base, existingUsers: 2, managedByEe: true, invite: { role: 'admin' } })).toEqual({ role: 'admin' })
    expect(ownerPolicyForNewUser({ ...base, existingUsers: 2, managedByEe: false, invite: { role: 'member' } })).toEqual({ role: 'member' })
  })

  it('outside ee (dev, tests) the first signup is the owner, later ones are members', () => {
    expect(ownerPolicyForNewUser({ ...base, existingUsers: 0, managedByEe: false })).toEqual({ role: 'owner' })
    expect(ownerPolicyForNewUser({ ...base, existingUsers: 3, managedByEe: false })).toEqual({ role: 'member' })
  })
})

describe('signInGate (who gets a sign-in code)', () => {
  it('on a claimed ee server, an address without an account gets a plain not-a-member answer, no owner/claim language', () => {
    const msg = signInGate({ managedByEe: true, existingUsers: 1, accountExists: false, companyName: 'Kindred' })
    expect(msg).toBe("You're not a member of Kindred yet. Ask the owner for an invite.")
    expect(msg).not.toMatch(/claim|already has an owner/i)
  })

  it('members get their code; dev servers stay open', () => {
    expect(signInGate({ managedByEe: true, existingUsers: 1, accountExists: true, companyName: 'Kindred' })).toBeNull()
    expect(signInGate({ managedByEe: false, existingUsers: 1, accountExists: false, companyName: null })).toBeNull()
  })

  it('names the company generically when it has no name yet', () => {
    expect(notAMemberMessage(null)).toBe("You're not a member of this company yet. Ask the owner for an invite.")
  })
})
