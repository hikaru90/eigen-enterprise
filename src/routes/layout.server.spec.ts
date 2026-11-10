import { describe, expect, it, vi } from 'vitest'
import { load } from './+layout.server'

const { getDbMock, findActiveVisualSetMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  findActiveVisualSetMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/auth/user-role', () => ({
  getUserRole: vi.fn().mockResolvedValue('member'),
  isAdminRole: (role: string | null) => role === 'owner' || role === 'admin',
}))
vi.mock('$lib/i18n/ui-locale', () => ({ normalizeUiLocale: (value: string) => value }))
vi.mock('$lib/paraglide/runtime', () => ({ cookieName: 'locale', cookieMaxAge: 31_536_000 }))
const { isHarnessUserMock } = vi.hoisted(() => ({ isHarnessUserMock: vi.fn(async () => false) }))
vi.mock('$lib/server/auth/harness-account', () => ({ isHarnessUser: isHarnessUserMock }))
vi.mock('../../modules/brand/store', () => ({
  defaultBrandStore: () => ({ findActiveVisualSet: findActiveVisualSetMock }),
}))
const { foundingCompanyNameMock } = vi.hoisted(() => ({ foundingCompanyNameMock: vi.fn(async (): Promise<string | null> => null) }))
vi.mock('$lib/server/overview/sources', () => ({ foundingCompanyName: foundingCompanyNameMock }))

function makeCookies() {
  return {
    get: vi.fn(() => undefined),
    set: vi.fn(),
  }
}

describe('layout server load', () => {
  it('returns user or null', async () => {
    findActiveVisualSetMock.mockResolvedValue(null)
    getDbMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi
              .fn()
              .mockResolvedValue([{ preferredUiLocale: 'en', preferredLanguage: 'de' }]),
            then(
              onFulfilled?: (value: unknown) => unknown,
              onRejected?: (error: unknown) => unknown,
            ) {
              return Promise.resolve([]).then(onFulfilled, onRejected)
            },
          }),
        }),
      }),
      selectDistinct: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([]),
        }),
      }),
    })

    const cookies = makeCookies()
    await expect(load({ locals: { user: { id: 'u1' } }, cookies } as never)).resolves.toEqual({
      user: { id: 'u1' },
      isAdmin: false,
      isOwner: false,
      preferredUiLocale: 'en',
      preferredLanguage: 'de',
      authorLayers: [{ key: 'user', label: 'You', kind: 'user' }],
      activeVisualSet: null,
      app: { name: 'eigenEnterprise', iconVersion: null },
    })

    await expect(load({ locals: { user: undefined }, cookies } as never)).resolves.toEqual({
      user: null,
      isAdmin: false,
      isOwner: false,
      preferredUiLocale: null,
      preferredLanguage: 'en',
      authorLayers: [],
      activeVisualSet: null,
      app: { name: 'eigenEnterprise', iconVersion: null },
    })
  })

  it('exposes the active visual set tokens when one is active (phase-2d M5/V9)', async () => {
    findActiveVisualSetMock.mockResolvedValue({
      id: '6a000000-0000-4000-8000-00000000000a',
      cssVars: { '--background': '#e8ede5', '--font-sans': '"Inter"' },
      darkCssVars: { '--background': '#0b0f0c' },
    })
    getDbMock.mockReturnValue({
      selectDistinct: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      }),
    })

    const result = (await load({ locals: { user: undefined }, cookies: makeCookies() } as never)) as {
      activeVisualSet: { cssVars: Record<string, string>; darkCssVars: Record<string, string> } | null
    }
    expect(result.activeVisualSet).toEqual({
      cssVars: { '--background': '#e8ede5', '--font-sans': '"Inter"' },
      darkCssVars: { '--background': '#0b0f0c' },
    })
  })

  it("carries the app's identity for the head (home-screen name, branded icons)", async () => {
    findActiveVisualSetMock.mockResolvedValue({
      id: '6a000000-0000-4000-8000-00000000000a',
      cssVars: { '--primary': '#5b2a6e', '--primary-foreground': '#ffffff', '--background': '#faf6ee' },
      darkCssVars: null,
    })
    foundingCompanyNameMock.mockResolvedValueOnce('Kindred')
    getDbMock.mockReturnValue({ selectDistinct: vi.fn().mockReturnValue({ from: vi.fn().mockResolvedValue([]) }) })

    const result = (await load({ locals: { user: undefined }, cookies: makeCookies() } as never)) as {
      app: { name: string; iconVersion: string | null }
    }
    expect(result.app.name).toBe('Kindred')
    expect(result.app.iconVersion).toMatch(/^[0-9a-z]+$/)
  })

  it('propagates brand store failures loud — only "none active" resolves null', async () => {
    findActiveVisualSetMock.mockRejectedValue(new Error('db connection failed'))
    getDbMock.mockReturnValue({
      selectDistinct: vi.fn().mockReturnValue({
        from: vi.fn().mockResolvedValue([]),
      }),
    })

    await expect(load({ locals: { user: undefined }, cookies: makeCookies() } as never)).rejects.toThrow(
      /db connection failed/,
    )
  })

  it('P-5 profile gate: a person without a complete profile is redirected from a shell page to the profile step', async () => {
    findActiveVisualSetMock.mockClear()
    const user = { id: 'u9', firstName: 'Ada', lastName: 'Lovelace', avatarSha256: null }
    const url = new URL('http://localhost/messages?c=abc')
    await expect(
      load({ locals: { user }, cookies: makeCookies(), route: { id: '/(nucleus)/messages' }, url } as never),
    ).rejects.toMatchObject({ status: 303, location: '/welcome/profile?next=%2Fmessages%3Fc%3Dabc' })
    expect(isHarnessUserMock).toHaveBeenCalledWith('u9')
    expect(findActiveVisualSetMock).not.toHaveBeenCalled() // the gate runs before anything else loads
  })

  it('P-5 profile gate: the invite (passkey step) and the profile step itself are never gated', async () => {
    findActiveVisualSetMock.mockResolvedValue(null)
    getDbMock.mockReturnValue({
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
            then(onFulfilled?: (value: unknown) => unknown, onRejected?: (error: unknown) => unknown) {
              return Promise.resolve([]).then(onFulfilled, onRejected)
            },
          }),
        }),
      }),
      selectDistinct: vi.fn().mockReturnValue({ from: vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue([]) }) }),
    })
    const user = { id: 'u9', firstName: null, lastName: null, avatarSha256: null }
    for (const id of ['/invite', '/welcome/profile']) {
      const result = (await load({
        locals: { user },
        cookies: makeCookies(),
        route: { id },
        url: new URL(`http://localhost${id}`),
      } as never)) as { user: unknown }
      expect(result.user).toBe(user)
    }
  })
})
