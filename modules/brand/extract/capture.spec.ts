import { describe, expect, it, vi } from 'vitest'
import { BROWSER_UNAVAILABLE_MESSAGE, BrowserUnavailableError } from './capture-errors'

const { assertPublicUrlMock } = vi.hoisted(() => ({ assertPublicUrlMock: vi.fn() }))
vi.mock('./ssrf-guard', () => ({ assertPublicUrl: assertPublicUrlMock }))

const { captureSite, defaultBrowserProbe, requireBrowserExecutable } = await import('./capture')

function probe(executablePath: string | null, executable: boolean) {
  return {
    executablePath: vi.fn(() => executablePath),
    isExecutable: vi.fn(async () => executable),
  }
}

describe('requireBrowserExecutable', () => {
  it('returns the headless browser executable when it is installed', async () => {
    await expect(
      requireBrowserExecutable(probe('/opt/pw/chrome-headless-shell', true)),
    ).resolves.toBe('/opt/pw/chrome-headless-shell')
  })

  it('throws BrowserUnavailableError (plain message, the expected path kept) when the browser is not installed', async () => {
    const missing = probe('/opt/pw/chrome-headless-shell', false)
    const err = await requireBrowserExecutable(missing).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(BrowserUnavailableError)
    expect((err as BrowserUnavailableError).code).toBe('browser_unavailable')
    expect((err as BrowserUnavailableError).message).toBe(BROWSER_UNAVAILABLE_MESSAGE)
    expect((err as BrowserUnavailableError).executablePath).toBe('/opt/pw/chrome-headless-shell')
    expect(missing.isExecutable).toHaveBeenCalledWith('/opt/pw/chrome-headless-shell')
  })

  it('throws BrowserUnavailableError when Playwright has no browser build for this platform', async () => {
    const unsupported = probe(null, true)
    await expect(requireBrowserExecutable(unsupported)).rejects.toBeInstanceOf(
      BrowserUnavailableError,
    )
    expect(unsupported.isExecutable).not.toHaveBeenCalled()
  })
})

describe('defaultBrowserProbe', () => {
  it('names the headless browser Playwright installs for this platform', () => {
    const path = defaultBrowserProbe.executablePath()
    expect(typeof path).toBe('string')
    expect(path!.length).toBeGreaterThan(0)
  })

  it('checks the file on disk: a missing path is not executable, the node binary is', async () => {
    await expect(
      defaultBrowserProbe.isExecutable('/nonexistent/ee/chrome-headless-shell'),
    ).resolves.toBe(false)
    await expect(defaultBrowserProbe.isExecutable(process.execPath)).resolves.toBe(true)
  })
})

describe('captureSite', () => {
  it('fails with BrowserUnavailableError before resolving the URL when no browser is installed', async () => {
    assertPublicUrlMock.mockReset()
    await expect(
      captureSite('https://example.com', {
        browser: probe('/opt/pw/chrome-headless-shell', false),
      }),
    ).rejects.toBeInstanceOf(BrowserUnavailableError)
    expect(assertPublicUrlMock).not.toHaveBeenCalled()
  })
})
