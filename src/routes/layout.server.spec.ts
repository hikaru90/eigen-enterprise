import { describe, expect, it, vi } from 'vitest'
import { load } from './+layout.server'

const { getDbMock, findActiveVisualSetMock } = vi.hoisted(() => ({
  getDbMock: vi.fn(),
  findActiveVisualSetMock: vi.fn(),
}))

vi.mock('$lib/server/db', () => ({ getDb: getDbMock }))
vi.mock('$lib/server/auth/user-role', () => ({ isUserAdmin: vi.fn().mockResolvedValue(false) }))
vi.mock('$lib/i18n/ui-locale', () => ({ normalizeUiLocale: (value: string) => value }))
vi.mock('$lib/paraglide/runtime', () => ({ cookieName: 'locale', cookieMaxAge: 31_536_000 }))
vi.mock('../../modules/brand/store', () => ({
  defaultBrandStore: () => ({ findActiveVisualSet: findActiveVisualSetMock }),
}))

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
      preferredUiLocale: 'en',
      preferredLanguage: 'de',
      authorLayers: [{ key: 'user', label: 'You', kind: 'user' }],
      activeVisualSet: null,
    })

    await expect(load({ locals: { user: undefined }, cookies } as never)).resolves.toEqual({
      user: null,
      isAdmin: false,
      preferredUiLocale: null,
      preferredLanguage: 'en',
      authorLayers: [],
      activeVisualSet: null,
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
})
