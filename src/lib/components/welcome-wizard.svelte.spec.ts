import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

const { invalidateAllMock, gotoMock, fetchMock } = vi.hoisted(() => ({
  invalidateAllMock: vi.fn(),
  gotoMock: vi.fn(),
  fetchMock: vi.fn(),
}))

vi.mock('$app/navigation', () => ({
  invalidateAll: invalidateAllMock,
  goto: gotoMock,
}))

vi.mock('$app/paths', () => ({
  base: '',
  resolve: (path: string) => path,
}))

import WelcomeWizard from './welcome-wizard.svelte'

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  }
}

describe('welcome-wizard.svelte', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockResolvedValue(okResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    return () => vi.unstubAllGlobals()
  })

  it('opens on what this is — in plain words', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true })

    await expect.element(page.getByText("your company's operating system")).toBeInTheDocument()
    await expect.element(page.getByText('Step 1 of 4')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Skip setup' })).toBeInTheDocument()
  })

  it('walks welcome → capabilities → connect (ready) → first move', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true })

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.element(page.getByText('Step 2 of 4')).toBeInTheDocument()
    await expect.element(page.getByText('Capture', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText('Knowledge graph')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.element(page.getByText('Step 3 of 4')).toBeInTheDocument()
    await expect.element(page.getByText('Your AI is connected.')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Continue' }).click()
    await expect.element(page.getByText('Step 4 of 4')).toBeInTheDocument()
    await expect.element(page.getByText('What do you want to do first?')).toBeInTheDocument()
  })

  it('embeds the provider wizard when no provider works — and hides the skip', async () => {
    render(WelcomeWizard, { providerReady: false, byokUiEnabled: true })

    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Skip setup' })).not.toBeInTheDocument()
  })

  it('completing the last step persists the tour and refreshes the page data', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true })

    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Start with the chat' }).click()

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/onboarding/welcome',
      expect.objectContaining({ method: 'POST' }),
    )
    await vi.waitFor(() => expect(invalidateAllMock).toHaveBeenCalled())
  })

  it('skip setup persists the tour immediately', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true })

    await page.getByRole('button', { name: 'Skip setup' }).click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(invalidateAllMock).toHaveBeenCalled()
    })
  })

  it('destination cards persist the tour and navigate', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true })

    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Continue' }).click()
    await page.getByRole('button', { name: 'Capture a thought' }).click()

    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
      expect(gotoMock).toHaveBeenCalledWith('/capture')
    })
  })

  it('fails loud when the completion call breaks', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, json: async () => ({ error: 'db down' }) })
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true })

    await page.getByRole('button', { name: 'Skip setup' }).click()

    await expect.element(page.getByText(/db down/)).toBeInTheDocument()
    expect(invalidateAllMock).not.toHaveBeenCalled()
  })
})
