import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

const { gotoMock, fetchMock } = vi.hoisted(() => ({
  gotoMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('$app/navigation', () => ({
  goto: gotoMock,
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
    window.__eeInstall = { prompt: null, installed: false }
    return () => {
      vi.unstubAllGlobals()
      vi.restoreAllMocks()
      delete window.__eeInstall
    }
  })

  it('offers the theme switch (Light · Dark · System); picking one stores it on this device', async () => {
    localStorage.removeItem('theme-preference')
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    const theme = page.getByTestId('menu-theme-switch')
    await expect
      .element(theme.getByRole('radio', { name: 'System' }))
      .toHaveAttribute('aria-checked', 'true')
    await theme.getByRole('radio', { name: 'Light' }).click()

    expect(localStorage.getItem('theme-preference')).toBe('light')
    await expect
      .element(theme.getByRole('radio', { name: 'Light' }))
      .toHaveAttribute('aria-checked', 'true')
    localStorage.removeItem('theme-preference')
  })

  it('offers Install app, which opens the install dialog and closes the menu', async () => {
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    await page.getByTestId('install-app').click()

    await expect.element(page.getByTestId('install-app-dialog')).toBeInTheDocument()
    await expect.element(page.getByTestId('install-app')).not.toBeInTheDocument()
  })

  it('hides Install app inside the installed app', async () => {
    const realMatchMedia = window.matchMedia.bind(window)
    vi.spyOn(window, 'matchMedia').mockImplementation((query: string) =>
      query === '(display-mode: standalone)'
        ? ({ ...realMatchMedia(query), matches: true } as MediaQueryList)
        : realMatchMedia(query),
    )
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()

    await expect.element(page.getByTestId('sound-toggle')).toBeInTheDocument()
    await expect.element(page.getByTestId('install-app')).not.toBeInTheDocument()
  })

  it('renders the personal preferences trigger', async () => {
    render(HomeSettingsMenu)

    await expect.element(page.getByRole('button', { name: 'Your preferences' })).toBeInTheDocument()
  })

  it('holds only personal prefs + sign out: no Settings link (main nav owns it, 81319f0e), no restart onboarding (68912711)', async () => {
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()

    await expect.element(page.getByTestId('menu-theme-switch')).toBeInTheDocument()
    await expect.element(page.getByTestId('sound-toggle')).toHaveTextContent('Sound on')
    await expect.element(page.getByTestId('voice-toggle')).toHaveTextContent('Voice on')
    await expect.element(page.getByTestId('voice-playback-toggle')).toBeInTheDocument()
    await expect.element(page.getByTestId('sign-out')).toBeInTheDocument()
    await expect.element(page.getByRole('link', { name: 'Settings' })).not.toBeInTheDocument()
    await expect.element(page.getByTestId('restart-onboarding')).not.toBeInTheDocument()
  })

  it('the voice toggle flips the persisted flag — assistant speech is a real choice', async () => {
    window.localStorage.removeItem('ee-voice')
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    await expect.element(page.getByTestId('voice-toggle')).toHaveTextContent('Voice on')

    await page.getByTestId('voice-toggle').click()
    await expect.element(page.getByTestId('voice-toggle')).toHaveTextContent('Voice off')
    expect(window.localStorage.getItem('ee-voice')).toBe('off')

    await page.getByTestId('voice-toggle').click()
    await expect.element(page.getByTestId('voice-toggle')).toHaveTextContent('Voice on')
    expect(window.localStorage.getItem('ee-voice')).toBeNull()
    window.localStorage.removeItem('ee-voice')
  })

  it('Audio devices, next to the voice toggle, opens the microphone + speaker choice', async () => {
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    const toggle = page.getByTestId('audio-devices-toggle')
    await expect.element(toggle).toHaveTextContent('Audio devices')
    expect(page.getByTestId('voice-toggle').element().nextElementSibling).toBe(toggle.element())
    await expect.element(page.getByTestId('audio-devices')).not.toBeInTheDocument()

    await toggle.click()
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByRole('group', { name: 'Audio devices' })).toBeInTheDocument()
    await expect.element(page.getByText('Microphone', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText('Speaker', { exact: true })).toBeInTheDocument()

    await toggle.click()
    await expect.element(page.getByTestId('audio-devices')).not.toBeInTheDocument()
  })

  it('Voice speed and volume, after Audio devices, opens the reading voice controls (74cbc486)', async () => {
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    const toggle = page.getByTestId('voice-playback-toggle')
    await expect.element(toggle).toHaveTextContent('Voice speed and volume')
    expect(
      page.getByTestId('audio-devices-toggle').element().compareDocumentPosition(toggle.element()),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING)
    await expect.element(page.getByTestId('voice-playback')).not.toBeInTheDocument()

    await toggle.click()
    await expect.element(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect.element(page.getByRole('slider', { name: 'Speed' })).toBeInTheDocument()
    await expect.element(page.getByRole('slider', { name: 'Volume' })).toBeInTheDocument()

    await toggle.click()
    await expect.element(page.getByTestId('voice-playback')).not.toBeInTheDocument()
  })

  it('the sound toggle flips the persisted flag — on by default, off stays off', async () => {
    window.localStorage.removeItem('ee-sound')
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    await expect.element(page.getByTestId('sound-toggle')).toHaveTextContent('Sound on')

    await page.getByTestId('sound-toggle').click()
    await expect.element(page.getByTestId('sound-toggle')).toHaveTextContent('Sound off')
    expect(window.localStorage.getItem('ee-sound')).toBe('off')

    await page.getByTestId('sound-toggle').click()
    await expect.element(page.getByTestId('sound-toggle')).toHaveTextContent('Sound on')
    expect(window.localStorage.getItem('ee-sound')).toBeNull()
    window.localStorage.removeItem('ee-sound')
  })

  it('sign out posts to the session endpoint and lands on /login', async () => {
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    await page.getByTestId('sign-out').click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/session/sign-out',
        expect.objectContaining({ method: 'POST', credentials: 'include' }),
      )
      expect(gotoMock).toHaveBeenCalledWith('/login')
    })
  })

  it('fails loud when sign out breaks — the menu shows the error and stays put', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    render(HomeSettingsMenu)

    await page.getByRole('button', { name: 'Your preferences' }).click()
    await page.getByTestId('sign-out').click()

    await expect.element(page.getByText(/Sign out failed \(HTTP 500\)\./)).toBeInTheDocument()
    expect(gotoMock).not.toHaveBeenCalled()
  })
})
