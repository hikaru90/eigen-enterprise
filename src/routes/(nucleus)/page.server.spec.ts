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
const onboardingFactsMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/onboarding/assisted', () => ({ onboardingFactsFor: onboardingFactsMock }))
vi.mock('$lib/server/mail', () => ({ companyMail: () => ({ isConfigured: mailConfiguredMock }) }))

const loadConversationMock = vi.hoisted(() =>
  vi.fn(async () => ({ sessionId: null as string | null, messages: [] as unknown[] })),
)
vi.mock('$lib/server/chat/current-conversation', () => ({
  loadCurrentConversation: loadConversationMock,
}))

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
    expect(
      await load({ locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') } as never),
    ).toMatchObject({ needsMail: true })
    mailConfiguredMock.mockResolvedValue(true)
    expect(
      await load({ locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') } as never),
    ).toMatchObject({ needsMail: false })
    isUserAdminMock.mockResolvedValue(false)
    mailConfiguredMock.mockResolvedValue(false)
    expect(
      await load({ locals: { user: { id: 'u2' } }, url: new URL('https://os.test/') } as never),
    ).toMatchObject({ needsMail: false })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isByokUiEnabledMock.mockReturnValue(true)
    authDbMock.select = () => selectChain({ accountKind: 'production', onboardingCompleted: false })
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: null }))
    onboardingFactsMock.mockResolvedValue({ website: 'not_started' })
  })

  it('offers the agent hand-off only while the website is still to do', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    const event = { locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') } as never
    expect(await load(event)).toMatchObject({ handoffAvailable: true })
    onboardingFactsMock.mockResolvedValue({ website: 'in_progress' })
    expect(await load(event)).toMatchObject({ handoffAvailable: false })
  })

  it('flags the return from the provider sign-in so the tour does not replay', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    const back = {
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/?provider=connected'),
    }
    expect(await load(back as never)).toMatchObject({ returnedFromProvider: true })
    const plain = { locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') }
    expect(await load(plain as never)).toMatchObject({ returnedFromProvider: false })
  })

  it('restores the saved conversation so navigating away and back keeps the chat', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    loadConversationMock.mockResolvedValue({
      sessionId: 's-1',
      messages: [
        { role: 'assistant', content: 'Welcome — your website next?', metadata: null },
        { role: 'user', content: 'yes', metadata: null },
      ],
    })
    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)
    expect(loadConversationMock).toHaveBeenCalledWith(expect.anything(), 'u1')
    expect(result).toMatchObject({
      chatSessionId: 's-1',
      chatHistory: [
        { role: 'assistant', content: 'Welcome — your website next?' },
        { role: 'user', content: 'yes' },
      ],
    })
  })

  it('starts empty when the user has no saved conversation', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    loadConversationMock.mockResolvedValue({ sessionId: null, messages: [] })
    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)
    expect(result).toMatchObject({ chatSessionId: null, chatHistory: [] })
  })

  it('redirects unauthenticated users to login', async () => {
    await expect(load({ locals: { user: null } } as never)).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('gates the chat behind first-run onboarding when no provider works', async () => {
    isUserProviderReadyMock.mockResolvedValue(false)

    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)

    expect(result).toMatchObject({
      needsOnboarding: true,
      showWelcome: true,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })

  it('offers the welcome wizard when a provider works but the tour is not done', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)

    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)

    expect(result).toMatchObject({
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

    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)

    expect(result).toMatchObject({
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

    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)

    expect(result).toMatchObject({
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

    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)

    expect(result).toMatchObject({
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

    const result = await load({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never)

    expect(result).toMatchObject({
      needsOnboarding: false,
      showWelcome: false,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })
})
