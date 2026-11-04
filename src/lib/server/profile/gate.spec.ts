import { describe, expect, it, vi } from 'vitest'
import { profileGateRedirect } from './gate'

const SHA = 'cd'.repeat(32)
const complete = { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', avatarSha256: SHA }
const noPicture = { id: 'u1', firstName: 'Ada', lastName: 'Lovelace', avatarSha256: null }

const at = (routeId: string | null, path: string) => () => ({ routeId, path })
const production = async () => false

describe('profile gate (P-5)', () => {
  it('sends a person without a complete profile from any shell page to the profile step, with next', async () => {
    expect(await profileGateRedirect({ user: noPicture, request: at('/(nucleus)', '/'), isHarness: production })).toBe(
      '/welcome/profile?next=%2F',
    )
    expect(
      await profileGateRedirect({ user: noPicture, request: at('/(nucleus)/messages', '/messages?c=x'), isHarness: production }),
    ).toBe('/welcome/profile?next=%2Fmessages%3Fc%3Dx')
    expect(
      await profileGateRedirect({
        user: { id: 'u2', firstName: null, lastName: null, avatarSha256: null },
        request: at('/(nucleus)/settings', '/settings'),
        isHarness: production,
      }),
    ).toBe('/welcome/profile?next=%2Fsettings')
  })

  it('lets a complete profile through without even looking at the request', async () => {
    const request = vi.fn(at('/(nucleus)', '/'))
    const isHarness = vi.fn(production)
    expect(await profileGateRedirect({ user: complete, request, isHarness })).toBeNull()
    expect(request).not.toHaveBeenCalled()
    expect(isHarness).not.toHaveBeenCalled()
  })

  it('never gates signed-out visitors, signed-out pages, the step itself or unknown routes', async () => {
    expect(await profileGateRedirect({ user: null, request: at('/(nucleus)', '/'), isHarness: production })).toBeNull()
    for (const routeId of ['/invite', '/login', '/signup', '/claim', '/welcome/profile', '/s/[slug]', null]) {
      expect(await profileGateRedirect({ user: noPicture, request: at(routeId, '/x'), isHarness: production })).toBeNull()
    }
    // A route id that merely starts with the group's name is not in it.
    expect(await profileGateRedirect({ user: noPicture, request: at('/(nucleus)x/y', '/y'), isHarness: production })).toBeNull()
  })

  it('leaves harness accounts (automated verification) alone', async () => {
    const isHarness = vi.fn(async () => true)
    expect(await profileGateRedirect({ user: noPicture, request: at('/(nucleus)', '/'), isHarness })).toBeNull()
    expect(isHarness).toHaveBeenCalledWith('u1')
  })

  it('never puts an off-site next into the redirect', async () => {
    expect(await profileGateRedirect({ user: noPicture, request: at('/(nucleus)', '//evil.example'), isHarness: production })).toBe(
      '/welcome/profile?next=%2F',
    )
  })
})
