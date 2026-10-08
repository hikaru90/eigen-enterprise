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

vi.mock('./provider-onboarding.svelte', async () => {
  const { default: ProviderOnboardingStub } = await import('./provider-onboarding.stub.svelte')
  return { default: ProviderOnboardingStub }
})

function okResponse(body: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  }
}

describe('welcome-wizard.svelte — the boot sequence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    fetchMock.mockResolvedValue(okResponse({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    window.localStorage.removeItem('ee-sound')
    return () => vi.unstubAllGlobals()
  })

  it('opens as a cinematic boot — a light, a greeting, no form-wizard chrome', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: null })

    await expect.element(page.getByTestId('welcome-wizard')).toBeInTheDocument()
    await expect.element(page.getByTestId('boot-orb')).toBeInTheDocument()
    await expect.element(page.getByText('Hello.')).toBeInTheDocument()
    // Dead chrome from the scrapped wizard never returns.
    await expect.element(page.getByText(/Step \d of \d/)).not.toBeInTheDocument()
  })

  it('asks for the name once, persists it, and greets by it', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: true,
      byokUiEnabled: true,
      displayName: null,
      oncomplete,
    })

    await page.getByText('What should I call you?').click()
    const nameInput = page.getByRole('textbox', { name: 'Your name' })
    await expect.element(nameInput).toBeInTheDocument()
    await nameInput.fill('Ada')
    await page.getByRole('button', { name: 'Continue' }).click()

    await vi.waitFor(() => {
      const call = fetchMock.mock.calls.find(([url]) => url === '/api/onboarding/name')
      expect(call).toBeTruthy()
      expect(JSON.parse((call![1] as { body: string }).body)).toEqual({ name: 'Ada' })
    })
    await expect
      .element(page.getByText('This is the operating system for your company.'))
      .toBeInTheDocument()
  })

  it('a known name skips the ask entirely', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: 'Ada' })

    await expect.element(page.getByText('Hello, Ada.')).toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'Your name' })).not.toBeInTheDocument()
  })

  it('tells the user what this is in outcome words — never internal jargon', async () => {
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: 'Ada' })

    await page.getByText('Hello, Ada.').click()
    await expect
      .element(page.getByText('This is the operating system for your company.'))
      .toBeInTheDocument()
    await expect
      .element(
        page.getByText(
          'You talk. It builds — your website, your work — and it remembers everything. Nothing happens without your approval.',
        ),
      )
      .toBeInTheDocument()

    // The scrapped module tour stays dead: no internal names, ever.
    for (const jargon of ['Nucleus', 'Capture', 'Knowledge graph', 'Brand studio', 'API keys']) {
      await expect.element(page.getByText(jargon)).not.toBeInTheDocument()
    }
  })

  it('with a working mind, Begin hands off to the chat — no capability list, no founding interview', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: true,
      byokUiEnabled: true,
      displayName: 'Ada',
      oncomplete,
    })

    await page.getByText('Hello, Ada.').click()
    await page.getByText('This is the operating system for your company.').click()
    await page.getByRole('button', { name: 'Begin' }).click()

    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: 'Ada' })
      const call = fetchMock.mock.calls.find(([url]) => url === '/api/onboarding/welcome')
      expect(call).toBeTruthy()
    })
    const foundingCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/onboarding/founding')
    expect(foundingCalls).toEqual([])
  })

  it('without a mind, the only gate is connecting one — real choices, or a muted skip', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: false,
      byokUiEnabled: true,
      displayName: 'Ada',
      oncomplete,
    })

    await page.getByText('Hello, Ada.').click()
    await page.getByText('This is the operating system for your company.').click()

    await expect
      .element(page.getByText('First, it needs a mind to think with.'))
      .toBeInTheDocument()
    await expect.element(page.getByTestId('provider-onboarding')).toBeInTheDocument()

    await page.getByTestId('skip-onboarding').click()
    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: 'Ada' })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('the mind connecting fires the handoff — the tour completes, no dead confirmation screen', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, {
      providerReady: false,
      byokUiEnabled: true,
      displayName: 'Ada',
      oncomplete,
    })

    await page.getByText('Hello, Ada.').click()
    await page.getByText('This is the operating system for your company.').click()
    await expect
      .element(page.getByText('First, it needs a mind to think with.'))
      .toBeInTheDocument()

    // The embedded provider wizard reports success through its explicit callback
    // ("Enter the workspace →" in the real component).
    await page.getByTestId('simulate-connected').click()

    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: 'Ada' })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('skip is reachable from the very first act and means complete-once', async () => {
    const oncomplete = vi.fn()
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: null, oncomplete })

    await page.getByTestId('skip-onboarding').click()

    await vi.waitFor(() => {
      expect(oncomplete).toHaveBeenCalledWith({ name: null })
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/onboarding/welcome',
        expect.objectContaining({ method: 'POST' }),
      )
    })
  })

  it('a failed name save fails loud and stays on the ask', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url === '/api/onboarding/name') {
        return Promise.resolve({ ok: false, status: 400, json: async () => ({ error: 'No.' }) })
      }
      return Promise.resolve(okResponse({ ok: true }))
    })
    render(WelcomeWizard, { providerReady: true, byokUiEnabled: true, displayName: null })

    const nameInput = page.getByRole('textbox', { name: 'Your name' })
    await nameInput.fill('Ada')
    await page.getByRole('button', { name: 'Continue' }).click()

    await expect.element(page.getByText('No.')).toBeInTheDocument()
    await expect.element(page.getByText('What should I call you?')).toBeInTheDocument()
    const welcomeCalls = fetchMock.mock.calls.filter(([url]) => url === '/api/onboarding/welcome')
    expect(welcomeCalls).toEqual([])
  })
})
