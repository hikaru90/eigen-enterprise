import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

const { invalidateAllMock, fetchMock } = vi.hoisted(() => ({
  invalidateAllMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
}))

vi.mock('$app/paths', () => ({
  base: '',
  resolve: (path: string) => path,
}))

import HomeSettingsMenu from './home-settings-menu.svelte'

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  }
}

describe('home-settings-menu.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockResolvedValue(okResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    return () => vi.unstubAllGlobals()
  })

  it('renders the settings cog trigger', async () => {
    render(HomeSettingsMenu)

    await expect.element(page.getByRole('button', { name: 'Settings menu' })).toBeInTheDocument()
  })

  it('opens a menu with API keys, LLM provider, settings, and restart onboarding', async () => {
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Settings menu' }).click()

    await expect.element(page.getByRole('link', { name: 'API Keys' })).toHaveAttribute(
      'href',
      '/api-keys',
    )
    await expect
      .element(page.getByRole('link', { name: 'AI provider' }))
      .toHaveAttribute('href', '/settings/llm')
    await expect
      .element(page.getByRole('link', { name: 'Settings', exact: true }))
      .toHaveAttribute('href', '/settings')
    await expect
      .element(page.getByRole('button', { name: 'Restart onboarding' }))
      .toBeInTheDocument()
  })

  it('restart onboarding clears the welcome stamp and refreshes page data', async () => {
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Settings menu' }).click()
    await page.getByRole('button', { name: 'Restart onboarding' }).click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome/reset',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(invalidateAllMock).toHaveBeenCalled()
    })
  })

  it('fails loud when the reset call breaks — the menu shows the exact error', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'db down' }) })
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Settings menu' }).click()
    await page.getByRole('button', { name: 'Restart onboarding' }).click()

    await expect.element(page.getByText(/db down/)).toBeInTheDocument()
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })
})
