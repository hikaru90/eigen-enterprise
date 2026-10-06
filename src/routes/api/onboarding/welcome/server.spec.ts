import { beforeEach, describe, expect, it, vi } from 'vitest'

const { completeWelcomeOnboardingMock } = vi.hoisted(() => ({
  completeWelcomeOnboardingMock: vi.fn(),
}))

vi.mock('$lib/server/onboarding/welcome', () => ({
  completeWelcomeOnboarding: completeWelcomeOnboardingMock,
}))

import { POST } from './+server'

function event(user: { id: string } | null = { id: 'u1' }) {
  return { locals: { user } } as Parameters<typeof POST>[0]
}

describe('POST /api/onboarding/welcome', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(event(null))
    expect(res.status).toBe(401)
    expect(completeWelcomeOnboardingMock).not.toHaveBeenCalled()
  })

  it('marks the welcome wizard done for the signed-in user', async () => {
    const res = await POST(event())

    expect(completeWelcomeOnboardingMock).toHaveBeenCalledWith('u1')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('fails loud when persistence breaks — never a fake ok', async () => {
    completeWelcomeOnboardingMock.mockRejectedValue(new Error('db down'))

    await expect(POST(event())).rejects.toThrow('db down')
    expect(completeWelcomeOnboardingMock).toHaveBeenCalledTimes(1)
  })
})
