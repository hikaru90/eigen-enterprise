import { beforeEach, describe, expect, it, vi } from 'vitest'

const { resetWelcomeOnboardingMock } = vi.hoisted(() => ({
  resetWelcomeOnboardingMock: vi.fn(),
}))

vi.mock('$lib/server/onboarding/welcome', () => ({
  resetWelcomeOnboarding: resetWelcomeOnboardingMock,
}))

import { POST } from './+server'

function event(user: { id: string } | null = { id: 'u1' }) {
  return { locals: { user } } as Parameters<typeof POST>[0]
}

describe('POST /api/onboarding/welcome/reset', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(event(null))
    expect(res.status).toBe(401)
    expect(resetWelcomeOnboardingMock).not.toHaveBeenCalled()
  })

  it('clears the welcome stamp for the signed-in user', async () => {
    const res = await POST(event())

    expect(resetWelcomeOnboardingMock).toHaveBeenCalledWith('u1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('fails loud when persistence breaks — never a fake ok', async () => {
    resetWelcomeOnboardingMock.mockRejectedValue(new Error('db down'))

    await expect(POST(event())).rejects.toThrow('db down')
    expect(resetWelcomeOnboardingMock).toHaveBeenCalledTimes(1)
  })
})
