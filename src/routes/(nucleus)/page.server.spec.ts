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
const { roleMock, completeWelcomeMock, setAccountNameMock, mailConfiguredMock } = vi.hoisted(() => ({
  roleMock: vi.fn(async (): Promise<'owner' | 'admin' | 'member'> => 'owner'),
  completeWelcomeMock: vi.fn(async () => {}),
  setAccountNameMock: vi.fn(async () => {}),
  mailConfiguredMock: vi.fn(async () => true),
}))
vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: roleMock,
  isAdminRole: (r: string | null) => r === 'owner' || r === 'admin',
}))
const invitedMock = vi.hoisted(() => vi.fn(async () => true))
vi.mock('$lib/server/members/joined', async (orig) => ({
  ...(await orig<typeof import('$lib/server/members/joined')>()),
  joinedByInvite: invitedMock,
}))
vi.mock('$lib/server/onboarding/welcome', () => ({
  completeWelcomeOnboarding: completeWelcomeMock,
  setAccountName: setAccountNameMock,
}))
const onboardingFactsMock = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/onboarding/assisted', () => ({ onboardingFactsFor: onboardingFactsMock }))
vi.mock('$lib/server/mail', () => ({ companyMail: () => ({ isConfigured: mailConfiguredMock }) }))

const loadDashboardMock = vi.hoisted(() =>
  vi.fn(async () => ({ overview: { modules: [], actions: [], approvals: [] }, backup: null })),
)
vi.mock('$lib/server/overview/dashboard', () => ({ loadDashboard: loadDashboardMock }))

/** Stand-in for event.fetch against GET /api/approvals/mode (built by another workstream). */
function modeFetch(res: { ok: boolean; body?: unknown }) {
  return vi.fn(async () => ({ ok: res.ok, status: res.ok ? 200 : 404, json: async () => res.body }))
}

import { load } from './+page.server'

/** The owner/admin load also asks /api/approvals/mode: a default answer unless a test brings its own. */
function withFetch<T>(event: T): T {
  return { fetch: modeFetch({ ok: true, body: { mode: 'ask' } }), ...(event as object) } as T
}

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
    roleMock.mockResolvedValue('owner')
    mailConfiguredMock.mockResolvedValue(false)
    const fetch = modeFetch({ ok: true, body: { mode: 'ask' } })
    expect(
      await load(withFetch({ locals: { user: { id: 'u1' } }, url: new URL('https://os.test/'), fetch } as never)),
    ).toMatchObject({ needsMail: true })
    mailConfiguredMock.mockResolvedValue(true)
    expect(
      await load(withFetch({ locals: { user: { id: 'u1' } }, url: new URL('https://os.test/'), fetch } as never)),
    ).toMatchObject({ needsMail: false })
    roleMock.mockResolvedValue('member')
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date() }))
    mailConfiguredMock.mockResolvedValue(false)
    expect(
      await load(withFetch({ locals: { user: { id: 'u2' } }, url: new URL('https://os.test/') } as never)),
    ).toMatchObject({ needsMail: false })
  })

  beforeEach(() => {
    vi.clearAllMocks()
    isByokUiEnabledMock.mockReturnValue(true)
    authDbMock.select = () => selectChain({ accountKind: 'production', onboardingCompleted: false })
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: null }))
    onboardingFactsMock.mockResolvedValue({ website: 'not_started' })
    roleMock.mockResolvedValue('owner')
    mailConfiguredMock.mockResolvedValue(true)
  })

  it('a member who just joined goes straight to Messages — no company onboarding, no provider setup', async () => {
    roleMock.mockResolvedValue('member')
    isUserProviderReadyMock.mockResolvedValue(false)
    await expect(load(withFetch({ locals: { user: { id: 'm1', name: 'Anna' } }, url: new URL('https://os.test/') } as never))).rejects.toMatchObject({
      status: 303,
      location: '/messages',
    })
    expect(completeWelcomeMock).toHaveBeenCalledWith('m1')
    // Later visits: the dashboard, never the setup wizard.
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date() }))
    expect(await load(withFetch({ locals: { user: { id: 'm1', name: 'Anna' } }, url: new URL('https://os.test/') } as never))).toMatchObject({
      needsOnboarding: false,
      showWelcome: false,
    })
  })

  it('an account that signed up without an invite founds the company: it keeps the onboarding', async () => {
    roleMock.mockResolvedValue('member')
    invitedMock.mockResolvedValue(false)
    isUserProviderReadyMock.mockResolvedValue(false)
    expect(await load(withFetch({ locals: { user: { id: 'f1', email: 'f@x.test', name: '' } }, url: new URL('https://os.test/') } as never))).toMatchObject({
      needsOnboarding: true,
      showWelcome: true,
    })
    invitedMock.mockResolvedValue(true)
  })

  it('an admin gets the company onboarding only while no provider works', async () => {
    roleMock.mockResolvedValue('admin')
    isUserProviderReadyMock.mockResolvedValue(false)
    expect(await load(withFetch({ locals: { user: { id: 'a1', name: 'Al' } }, url: new URL('https://os.test/') } as never))).toMatchObject({
      needsOnboarding: true,
      showWelcome: true,
    })
    isUserProviderReadyMock.mockResolvedValue(true)
    await expect(load(withFetch({ locals: { user: { id: 'a1', name: 'Al' } }, url: new URL('https://os.test/') } as never))).rejects.toMatchObject({ location: '/messages' })
  })

  it('heals an account name that was only saved as the onboarding name', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date(), displayName: 'Olivia Owner' }))
    await load(withFetch({ locals: { user: { id: 'o1', name: '' } }, url: new URL('https://os.test/') } as never))
    expect(setAccountNameMock).toHaveBeenCalledWith('o1', 'Olivia Owner')
    setAccountNameMock.mockClear()
    await load(withFetch({ locals: { user: { id: 'o1', name: 'Olivia' } }, url: new URL('https://os.test/') } as never))
    expect(setAccountNameMock).not.toHaveBeenCalled()
  })

  it('offers the agent hand-off only while the website is still to do', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    const event = { locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') } as never
    expect(await load(withFetch(event))).toMatchObject({ handoffAvailable: true })
    onboardingFactsMock.mockResolvedValue({ website: 'in_progress' })
    expect(await load(withFetch(event))).toMatchObject({ handoffAvailable: false })
  })

  it('flags the return from the provider sign-in so the tour does not replay', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    const back = {
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/?provider=connected'),
    }
    expect(await load(withFetch(back as never))).toMatchObject({ returnedFromProvider: true })
    const plain = { locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') }
    expect(await load(withFetch(plain as never))).toMatchObject({ returnedFromProvider: false })
  })

  it('redirects unauthenticated users to login', async () => {
    await expect(load(withFetch({ locals: { user: null } } as never))).rejects.toMatchObject({
      status: 302,
      location: '/login',
    })
  })

  it('gates the dashboard behind first-run onboarding when no provider works', async () => {
    isUserProviderReadyMock.mockResolvedValue(false)

    const result = await load(withFetch({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never))

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

    const result = await load(withFetch({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never))

    expect(result).toMatchObject({
      needsOnboarding: false,
      showWelcome: true,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })

  it('goes straight to the dashboard when the tour is done and a provider works', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date('2026-09-22T10:00:00Z') }))

    const result = await load(withFetch({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never))

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

    const result = await load(withFetch({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never))

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

    const result = await load(withFetch({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never))

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

    const result = await load(withFetch({
      locals: { user: { id: 'u1' } },
      url: new URL('https://os.test/'),
    } as never))

    expect(result).toMatchObject({
      needsOnboarding: false,
      showWelcome: false,
      byokUiEnabled: true,
      displayName: null,
      needsMail: false,
    })
  })

  it('the dashboard loads only once the first-run flows are done', async () => {
    isUserProviderReadyMock.mockResolvedValue(false)
    const first = await load(withFetch({ locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') } as never))
    expect(first).toMatchObject({ showWelcome: true, dashboard: null })
    expect(loadDashboardMock).not.toHaveBeenCalled()

    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date() }))
    const done = await load(withFetch({ locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') } as never))
    expect(loadDashboardMock).toHaveBeenCalledWith('u1')
    expect(done).toMatchObject({
      showWelcome: false,
      needsOnboarding: false,
      dashboard: { overview: { modules: [], actions: [], approvals: [] }, backup: null },
    })
  })

  it('greets by the first name of the account, else of the onboarding name', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date() }))
    const profile = await load(withFetch({ locals: { user: { id: 'u1', name: 'Ada Lovelace', firstName: 'Augusta' } }, url: new URL('https://os.test/') } as never))
    expect(profile).toMatchObject({ greetingName: 'Augusta' })
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date(), displayName: 'Ada Lovelace' }))
    const named = await load(withFetch({ locals: { user: { id: 'u1', name: 'Grace Hopper' } }, url: new URL('https://os.test/') } as never))
    expect(named).toMatchObject({ greetingName: 'Grace' })
    const onboardingOnly = await load(withFetch({ locals: { user: { id: 'u1', name: '' } }, url: new URL('https://os.test/') } as never))
    expect(onboardingOnly).toMatchObject({ greetingName: 'Ada' })
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date() }))
    const anonymous = await load(withFetch({ locals: { user: { id: 'u1', name: ' ' } }, url: new URL('https://os.test/') } as never))
    expect(anonymous).toMatchObject({ greetingName: null })
  })

  it('carries no chat transcript: the conversation lives in the assistant panel', async () => {
    isUserProviderReadyMock.mockResolvedValue(true)
    getDbMock.mockReturnValue(selectChain({ welcomeCompletedAt: new Date() }))
    const data = await load(withFetch({ locals: { user: { id: 'u1' } }, url: new URL('https://os.test/') } as never))
    expect(data).not.toHaveProperty('chatHistory')
    expect(data).not.toHaveProperty('chatSessionId')
  })
})
