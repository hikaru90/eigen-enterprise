import { beforeEach, describe, expect, it, vi } from 'vitest'

const { authDbMock, getDbMock, isUserProviderReadyMock, isByokUiEnabledMock } = vi.hoisted(() => ({
  authDbMock: {},
  getDbMock: vi.fn(),
  isUserProviderReadyMock: vi.fn(),
  isByokUiEnabledMock: vi.fn(),
}))

vi.mock('$lib/server/db/auth-db', () => ({ authDb: authDbMock }))
vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/llm/provider-ready', () => ({
  isUserProviderReady: isUserProviderReadyMock,
}))
vi.mock('$lib/server/settings/byok-ui', () => ({ isByokUiEnabled: isByokUiEnabledMock }))
const { isUserAdminMock, mailConfiguredMock } = vi.hoisted(() => ({
  isUserAdminMock: vi.fn(async () => false),
  mailConfiguredMock: vi.fn(async () => true),
}))
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: isUserAdminMock }))
vi.mock('$lib/server/mail', () => ({ companyMail: () => ({ isConfigured: mailConfiguredMock }) }))

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
  it('asks the owner (only the owner) to set up company email until it works', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: null }))
    authDbMock.select = () => selectChain({ accountKind: 'production' })
    isUserAdminMock.mockResolvedValue(true)
    mailConfiguredMock.mockResolvedValue(false)
    expect(await load({ locals: { user: { id: 'u1' } } } as never)).toMatchObject({ needsMail: true })
    mailConfiguredMock.mockResolvedValue(true)
    expect(await load({ locals: { user: { id: 'u1' } } } as never)).toMatchObject({ needsMail: false })
    isUserAdminMock.mockResolvedValue(false)
    mailConfiguredMock.mockResolvedValue(false)
    expect(await load({ locals: { user: { id: 'u2' } } } as never)).toMatchObject({ needsMail: false })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isByokUiEnabledMock.mockReturnValue(true)
    authDbMock.select = () => selectChain({ accountKind: 'production', onboardingCompleted: false })
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: null }))
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

    expect(result).toEqual({
      needsOnboarding: true,
      showWelcome: true,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })

  it('offers the welcome wizard when a provider works but the tour is not done', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({
      needsOnboarding: false,
      showWelcome: true,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })

  it('goes straight to the chat when the tour is done and a provider works', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date('2026-09-22T10:00:00Z') }))

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({
      needsOnboarding: false,
      showWelcome: false,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })

  it('keeps the provider gate when the tour is done but the provider vanished', async () => {
    isUserProviderReadyMock.mockResolvedValue(false)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date('2026-09-22T10:00:00Z') }))

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({
      needsOnboarding: true,
      showWelcome: false,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })

  it('hands the saved name to the wizard so the boot greets by it', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: null, displayName: 'Ada' }))

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({
      needsOnboarding: false,
      showWelcome: true,
      byokUiEnabled: true,
      displayName: 'Ada',
      needsMail: false,
    })
  })

  it('never gates harness accounts — no wizard, no tour', async () => {
    authDbMock.select = () => selectChain({ accountKind: 'harness', onboardingCompleted: true })
    isUserProviderReadyMock.mockResolvedValue(false)

    const result = await load({ locals: { user: { id: 'u1' } } } as never)

    expect(result).toEqual({
      needsOnboarding: false,
      showWelcome: false,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })
})
