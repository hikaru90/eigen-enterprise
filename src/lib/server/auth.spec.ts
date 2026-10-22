import { beforeEach, describe, expect, it, vi } from 'vitest'

const betterAuthMock = vi.fn((config: unknown) => ({ config }))
const drizzleAdapterMock = vi.fn(() => ({ adapter: 'drizzle' }))
const sveltekitCookiesMock = vi.fn(() => ({ plugin: 'cookies' }))
const sendTransactionalEmailMock = vi.fn()
const recordVerificationLinkMock = vi.fn()
const resolveAccountKindMock = vi.fn(() => 'production')
const syncContactMock = vi.fn()

const env: Record<string, string | undefined> = {
  ORIGIN: 'http://localhost:5173',
  BETTER_AUTH_SECRET: 'secret',
}

vi.mock('better-auth/minimal', () => ({
  betterAuth: betterAuthMock,
}))

vi.mock('better-auth/adapters/drizzle', () => ({
  drizzleAdapter: drizzleAdapterMock,
}))

vi.mock('better-auth/svelte-kit', () => ({
  sveltekitCookies: sveltekitCookiesMock,
}))

vi.mock('$lib/server/env/private-env', () => ({
  env,
}))

vi.mock('$app/server', () => ({
  getRequestEvent: vi.fn(),
}))

/** Users already in the instance when a new one signs up (owner policy input). */
let existingUserCount = 0
vi.mock('$lib/server/db/auth-db', () => ({
  authDb: { select: () => ({ from: async () => [{ n: existingUserCount }] }) },
}))

/** Company email (database-backed): `sendTransactionalEmailMock` stands in for its send. */
vi.mock('$lib/server/mail', () => ({
  companyMail: () => ({
    send: (...args: unknown[]) => sendTransactionalEmailMock(...args),
    isConfigured: async () => true,
  }),
}))

vi.mock('$lib/server/e2e/verification-link-store', () => ({
  recordVerificationLink: (...args: unknown[]) => recordVerificationLinkMock(...args),
  recordSignInCode: vi.fn(),
}))

const consumeInviteMock = vi.fn(async (_id: string, _now: Date) => true)
vi.mock('$lib/server/members/db-store', () => ({ dbMemberStore: { consumeInvite: (id: string, now: Date) => consumeInviteMock(id, now) } }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: async () => 'Kindred' }))

vi.mock('$lib/auth/account-kind', () => ({
  resolveAccountKindForNewUser: (...args: unknown[]) => resolveAccountKindMock(...args),
}))

vi.mock('$lib/server/auth-owlery-sync', () => ({
  syncOwleryContactForVerifiedUser: (...args: unknown[]) => syncContactMock(...args),
}))

function clearMailEnv() {
  delete env.GITHUB_CLIENT_ID
  delete env.GITHUB_CLIENT_SECRET
  delete env.GOOGLE_CLIENT_ID
  delete env.GOOGLE_CLIENT_SECRET
}

async function loadAuth() {
  vi.resetModules()
  betterAuthMock.mockClear()
  drizzleAdapterMock.mockClear()
  sveltekitCookiesMock.mockClear()
  sendTransactionalEmailMock.mockReset()
  recordVerificationLinkMock.mockReset()
  resolveAccountKindMock.mockReset()
  syncContactMock.mockReset()
  resolveAccountKindMock.mockReturnValue('production')
  sendTransactionalEmailMock.mockResolvedValue(undefined)
  return import('./auth')
}

type AuthConfig = {
  emailVerification?: {
    sendVerificationEmail: (input: { user: { email: string }; url: string }) => Promise<void>
    afterEmailVerification?: (user: {
      id: string
      email?: string
      emailVerified?: boolean
      firstName?: string | null
      lastName?: string | null
    }) => Promise<void>
  }
  emailAndPassword: {
    requireEmailVerification: boolean
    sendResetPassword?: (input: { user: { email: string }; url: string }) => Promise<void>
  }
  user: {
    changeEmail: {
      updateEmailWithoutVerification: boolean
      sendChangeEmailConfirmation?: (input: {
        user: { email: string }
        newEmail: string
        url: string
      }) => Promise<void>
    }
    additionalFields: Record<
      string,
      { type: string; required?: boolean; input?: boolean; returned?: boolean }
    >
  }
  socialProviders?: Record<
    string,
    { clientId: string; clientSecret: string; mapProfileToUser?: unknown }
  >
  account?: { accountLinking: { enabled: boolean; trustedProviders: string[] } }
  databaseHooks: {
    user: {
      create: {
        before: (user: { email?: string }) => Promise<{ data: Record<string, unknown> }>
        after: (user: {
          id: string
          email?: string
          firstName?: string | null
          lastName?: string | null
        }) => Promise<void>
      }
    }
  }
}

function lastConfig(): AuthConfig {
  expect(betterAuthMock).toHaveBeenCalled()
  return betterAuthMock.mock.calls[0][0] as AuthConfig
}

describe('auth config', () => {
  beforeEach(() => {
    clearMailEnv()
    env.ORIGIN = 'http://localhost:5173'
    env.BETTER_AUTH_SECRET = 'secret'
  })

  it('is passwordless: no verification-by-link and no password-reset mail (codes prove the address)', async () => {
    await loadAuth()
    const config = lastConfig()
    expect(config.emailAndPassword.requireEmailVerification).toBe(false)
    expect(config.emailAndPassword.sendResetPassword).toBeUndefined()
    expect(config.emailVerification).toBeUndefined()
  })

  it('a machine that signs in with a code stays signed in: the session is the device credential', async () => {
    await loadAuth()
    const config = lastConfig()
    expect(config.session?.expiresIn).toBe(60 * 60 * 24 * 365)
    // Rolling: active use extends the session, so a used machine never times out mid-work.
    expect(config.session?.updateAge).toBe(60 * 60 * 24)
  })

  it('offers passkeys: the machine credential registered after a code sign-in', async () => {
    await loadAuth()
    const config = lastConfig()
    const ids = (config.plugins ?? []).map((p) => (p as { id?: string }).id ?? '')
    expect(ids).toContain('passkey')
  })

  it('confirms an email change by email, through company mail', async () => {
    await loadAuth()
    const config = lastConfig()
    expect(config.user.changeEmail.updateEmailWithoutVerification).toBe(false)
    await config.user.changeEmail.sendChangeEmailConfirmation!({
      user: { email: 'old@b.com' },
      newEmail: 'new@b.com',
      url: 'https://app/change?token=3',
    })
    await vi.waitFor(() => expect(sendTransactionalEmailMock).toHaveBeenCalled())
    expect(sendTransactionalEmailMock).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'old@b.com',
        subject: 'Confirm your Eigen email change',
        html: expect.stringContaining('new@b.com'),
      }),
    )
  })

  it('logs when an auth email fails without throwing', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await loadAuth()
    sendTransactionalEmailMock.mockRejectedValue(new Error('smtp down'))
    await lastConfig().user.changeEmail.sendChangeEmailConfirmation!({
      user: { email: 'a@b.com' },
      newEmail: 'n@b.com',
      url: 'https://app/change',
    })
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalled())
    expect(errSpy).toHaveBeenCalledWith(
      '[auth] transactional email failed',
      expect.objectContaining({ to: 'a@b.com', error: 'smtp down' }),
    )
    errSpy.mockRestore()
  })

  it('enables social providers and account linking when credentials set', async () => {
    env.GITHUB_CLIENT_ID = 'gh-id'
    env.GITHUB_CLIENT_SECRET = 'gh-secret'

    await loadAuth()
    const config = lastConfig()
    expect(config.socialProviders).toEqual({
      github: {
        clientId: 'gh-id',
        clientSecret: 'gh-secret',
        mapProfileToUser: expect.any(Function),
      },
    })
    expect(config.account?.accountLinking).toEqual({
      enabled: true,
      trustedProviders: ['github'],
    })
  })

  it('declares firstName and lastName as optional user additional fields', async () => {
    await loadAuth()
    const config = lastConfig()
    expect(config.user.additionalFields.firstName).toMatchObject({
      type: 'string',
      required: false,
      input: true,
    })
    expect(config.user.additionalFields.lastName).toMatchObject({
      type: 'string',
      required: false,
      input: true,
    })
  })

  it('databaseHooks before sets accountKind from resolver', async () => {
    await loadAuth()
    resolveAccountKindMock.mockReturnValue('eval')
    const config = lastConfig()
    const result = await config.databaseHooks.user.create.before({ email: 'x@y.com' })
    expect(resolveAccountKindMock).toHaveBeenCalledWith('x@y.com')
    expect(result.data.accountKind).toBe('eval')
  })

  it('databaseHooks before makes the first user the owner, later ones members (dev)', async () => {
    await loadAuth()
    const config = lastConfig()
    existingUserCount = 0
    expect((await config.databaseHooks.user.create.before({ email: 'owner@y.com' })).data.role).toBe('owner')
    existingUserCount = 2
    expect((await config.databaseHooks.user.create.before({ email: 'second@y.com' })).data.role).toBe('member')
    existingUserCount = 0
  })

  it('on a claimed ee server, a new account needs an invite: it takes the invited role and consumes the invite once', async () => {
    await loadAuth()
    const { inviteScope } = await import('$lib/server/auth/owner-policy')
    const config = lastConfig()
    env.EE_WORKLOAD = 'os'
    existingUserCount = 1
    try {
      await expect(config.databaseHooks.user.create.before({ email: 'stranger@y.com' })).rejects.toThrow(
        "You're not a member of Kindred yet. Ask the owner for an invite.",
      )
      const scope = { inviteId: 'inv1', email: 'new@y.com', role: 'admin' as const }
      const made = await inviteScope.run(scope, () => config.databaseHooks.user.create.before({ email: 'New@y.com' }))
      expect(made.data.role).toBe('admin')
      expect(consumeInviteMock).toHaveBeenCalledWith('inv1', expect.any(Date))
      consumeInviteMock.mockResolvedValueOnce(false)
      await expect(inviteScope.run(scope, () => config.databaseHooks.user.create.before({ email: 'new@y.com' }))).rejects.toThrow(/already used/)
      await expect(inviteScope.run(scope, () => config.databaseHooks.user.create.before({ email: 'other@y.com' }))).rejects.toThrow(/different email/)
    } finally {
      delete env.EE_WORKLOAD
      existingUserCount = 0
    }
  })

  it('databaseHooks after hands the new user to the contact-book sync', async () => {
    await loadAuth()
    const config = lastConfig()
    const user = { id: 'user-3', email: 'ada@example.com', emailVerified: true, firstName: 'Ada' }
    await config.databaseHooks.user.create.after(user)
    expect(syncContactMock).toHaveBeenCalledWith(user)
  })
})

describe('normalizeAuthOrigin', () => {
  beforeEach(() => {
    clearMailEnv()
    env.ORIGIN = 'http://localhost:5173'
    env.BETTER_AUTH_SECRET = 'secret'
  })

  it('prepends https for bare hostnames', async () => {
    const { normalizeAuthOrigin } = await loadAuth()
    expect(normalizeAuthOrigin('eigen.stackstack.de')).toBe('https://eigen.stackstack.de')
  })

  it('leaves full http URLs unchanged aside from trailing slash strip', async () => {
    const { normalizeAuthOrigin } = await loadAuth()
    expect(normalizeAuthOrigin('http://localhost:5173')).toBe('http://localhost:5173')
  })

  it('strips trailing slash from https URLs', async () => {
    const { normalizeAuthOrigin } = await loadAuth()
    expect(normalizeAuthOrigin('https://app.example.com/')).toBe('https://app.example.com')
  })

  it('throws when missing', async () => {
    const { normalizeAuthOrigin } = await loadAuth()
    expect(() => normalizeAuthOrigin(undefined)).toThrow(/ORIGIN is not set/)
  })

  it('throws when blank', async () => {
    const { normalizeAuthOrigin } = await loadAuth()
    expect(() => normalizeAuthOrigin('   ')).toThrow(/ORIGIN is not set/)
  })

  it('throws for invalid URL after scheme prepend', async () => {
    const { normalizeAuthOrigin } = await loadAuth()
    expect(() => normalizeAuthOrigin('http://[::')).toThrow(/ORIGIN is not a valid URL/)
  })
})
