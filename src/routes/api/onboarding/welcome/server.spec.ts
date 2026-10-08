import { beforeEach, describe, expect, it, vi } from 'vitest'

const { completeWelcomeOnboardingMock, openWebsiteFoundingJourneyMock, bootAppMock } = vi.hoisted(
  () => ({
    completeWelcomeOnboardingMock: vi.fn(),
    openWebsiteFoundingJourneyMock: vi.fn(),
    bootAppMock: vi.fn(),
  }),
)

vi.mock('$lib/server/onboarding/welcome', () => ({
  completeWelcomeOnboarding: completeWelcomeOnboardingMock,
}))
vi.mock('$lib/server/onboarding/founding', () => ({
  openWebsiteFoundingJourney: openWebsiteFoundingJourneyMock,
}))
vi.mock('$lib/server/boot', () => ({ bootApp: bootAppMock }))

import { POST } from './+server'

function event(user: { id: string } | null = { id: 'u1' }) {
  return { locals: { user } } as Parameters<typeof POST>[0]
}

describe('POST /api/onboarding/welcome', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    bootAppMock.mockResolvedValue({ journeys: { store: true } })
    openWebsiteFoundingJourneyMock.mockResolvedValue('journey-1')
    completeWelcomeOnboardingMock.mockResolvedValue(undefined)
  })

  it('returns 401 when unauthenticated', async () => {
    const res = await POST(event(null))
    expect(res.status).toBe(401)
    expect(completeWelcomeOnboardingMock).not.toHaveBeenCalled()
    expect(openWebsiteFoundingJourneyMock).not.toHaveBeenCalled()
  })

  it('marks the tour done AND opens the founding journey for the chat to drive', async () => {
    const res = await POST(event())

    expect(completeWelcomeOnboardingMock).toHaveBeenCalledWith('u1')
    expect(openWebsiteFoundingJourneyMock).toHaveBeenCalledWith({
      journeys: { store: true },
      sessionId: 'onboarding:u1',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it('completing and skipping mean the same thing — both open the journey', async () => {
    // The endpoint takes no body: the boot sequence sends one call either way.
    await POST(event())
    expect(openWebsiteFoundingJourneyMock).toHaveBeenCalledTimes(1)
  })

  it('fails loud when persistence breaks — never a fake ok', async () => {
    completeWelcomeOnboardingMock.mockRejectedValue(new Error('db down'))

    await expect(POST(event())).rejects.toThrow('db down')
    expect(completeWelcomeOnboardingMock).toHaveBeenCalledTimes(1)
  })

  it('fails loud when the journey cannot open — a silent miss would fake the founding', async () => {
    openWebsiteFoundingJourneyMock.mockRejectedValue(new Error('journey store down'))

    await expect(POST(event())).rejects.toThrow('journey store down')
    expect(completeWelcomeOnboardingMock).toHaveBeenCalledTimes(1)
  })
})
