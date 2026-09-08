import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authDbMock, isUserProviderReadyMock, isByokUiEnabledMock } = vi.hoisted(() => ({
  authDbMock: {},
  isUserProviderReadyMock: vi.fn(),
  isByokUiEnabledMock: vi.fn(),
}))

vi.mock('$lib/server/db/auth-db', () => ({ authDb: authDbMock }))
vi.mock('$lib/server/llm/provider-ready', () => ({
  isUserProviderReady: isUserProviderReadyMock,
}))
vi.mock('$lib/server/settings/byok-ui', () => ({ isByokUiEnabled: isByokUiEnabledMock }))

import { load } from './+page.server'

function selectChain(row: Record<string, unknown> | undefined) {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.from = () => chain
  chain.where = () => chain
  chain.limit = () => Promise.resolve(row ? [row] : [])
  return chain
}

describe('nucleus page server load', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    isByokUiEnabledMock.mockReturnValue(true)
    authDbMock.select = () => selectChain({ accountKind: 'production', onboardingCompleted: false })
  })

  it('redirects unauthenticated users to login', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('gates the chat behind first-run onboarding when no provider works', async () => {
    isUserProviderReadyMock.mockResolvedValue(false)

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({ needsOnboarding: true, byokUiEnabled: true })
  })

  it('goes straight to the chat when a provider works', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({ needsOnboarding: false, byokUiEnabled: true })
  })

  it('never gates harness accounts', async () => {
    authDbMock.select = () => selectChain({ accountKind: 'harness', onboardingCompleted: true })
    isUserProviderReadyMock.mockResolvedValue(false)

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({ needsOnboarding: false, byokUiEnabled: true })
  })
})
