import type { BeforeInstallPromptEvent } from './install'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import InstallAppDialog from './install-app-dialog.svelte'

const IPHONE_SAFARI =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1'
const MAC_CHROME =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
const WIN_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0'

function fakePrompt(outcome: 'accepted' | 'dismissed') {
  const prompt = vi.fn(async () => {})
  const event = Object.assign(new Event('beforeinstallprompt'), {
    prompt,
    userChoice: Promise.resolve({ outcome }),
  }) as BeforeInstallPromptEvent
  return { event, prompt }
}

function asBrowser(userAgent: string, maxTouchPoints = 0) {
  vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue(userAgent)
  vi.spyOn(navigator, 'maxTouchPoints', 'get').mockReturnValue(maxTouchPoints)
}

async function openDialog() {
  const screen = render(InstallAppDialog)
  screen.component.show()
  await expect.element(page.getByTestId('install-app-dialog')).toBeInTheDocument()
  return screen
}

describe('install-app-dialog.svelte', () => {
  beforeEach(() => {
    window.__eeInstall = { prompt: null, installed: false }
  })
  afterEach(() => {
    vi.restoreAllMocks()
    delete window.__eeInstall
  })

  it('opens the browser’s own install dialog when one was captured', async () => {
    const { event, prompt } = fakePrompt('accepted')
    window.__eeInstall = { prompt: event, installed: false }
    await openDialog()

    await page.getByTestId('install-native').click()

    await vi.waitFor(() => expect(prompt).toHaveBeenCalledOnce())
    // Single-use: the spent event is gone from the slot.
    expect(window.__eeInstall?.prompt).toBeNull()
  })

  it('falls back to the menu path when the browser dialog is dismissed', async () => {
    asBrowser(MAC_CHROME)
    const { event } = fakePrompt('dismissed')
    window.__eeInstall = { prompt: event, installed: false }
    await openDialog()

    await page.getByTestId('install-native').click()

    await expect.element(page.getByTestId('install-steps')).toHaveTextContent(/Install page as app/)
  })

  it('shows Installed once the browser reports the install', async () => {
    await openDialog()
    window.__eeInstall = { prompt: null, installed: true }
    window.dispatchEvent(new Event('ee-install-change'))

    await expect.element(page.getByTestId('install-done')).toBeInTheDocument()
  })

  it('walks iPhone Safari through Share → Add to Home Screen', async () => {
    asBrowser(IPHONE_SAFARI, 5)
    await openDialog()

    await expect.element(page.getByTestId('install-steps')).toHaveTextContent(/Add to Home Screen/)
  })

  it('tells desktop Firefox where to go and copies the link', async () => {
    asBrowser(WIN_FIREFOX)
    const writeText = vi.fn(async () => {})
    vi.spyOn(navigator, 'clipboard', 'get').mockReturnValue({ writeText } as unknown as Clipboard)
    await openDialog()

    await expect.element(page.getByTestId('install-unsupported')).toHaveTextContent(/Chrome or Edge/)
    await page.getByTestId('install-copy-link').click()
    await vi.waitFor(() => expect(writeText).toHaveBeenCalledWith(window.location.origin))
    await expect.element(page.getByTestId('install-copy-link')).toHaveTextContent('Link copied')
  })

  it('fails loud when the app.html install capture is missing', async () => {
    delete window.__eeInstall
    await openDialog()

    await expect.element(page.getByTestId('install-error')).toHaveTextContent(/window.__eeInstall is missing/)
  })
})
