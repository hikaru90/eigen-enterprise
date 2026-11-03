import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/db/auth-db', () => ({ authDb: {} }))

import { companyOnboardingFor } from './joined'

describe('companyOnboardingFor', () => {
  it('the owner always; an invited member never; an invited admin only while no provider works', () => {
    expect(companyOnboardingFor({ role: 'owner', invited: false, providerReady: true })).toBe(true)
    expect(companyOnboardingFor({ role: 'member', invited: true, providerReady: false })).toBe(false)
    expect(companyOnboardingFor({ role: 'member', invited: true, providerReady: true })).toBe(false)
    expect(companyOnboardingFor({ role: 'admin', invited: true, providerReady: false })).toBe(true)
    expect(companyOnboardingFor({ role: 'admin', invited: true, providerReady: true })).toBe(false)
  })

  it('an account that signed up on its own (no invite) is founding the company', () => {
    expect(companyOnboardingFor({ role: 'member', invited: false, providerReady: false })).toBe(true)
  })
})
