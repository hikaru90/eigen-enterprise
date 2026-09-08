import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

// PostHog analytics must stay inert in component specs.
vi.mock('$lib/analytics/posthog-client', () => ({
  capture: () => undefined,
}))

import CaptureOnboardingOverlay from './capture-onboarding-overlay.svelte'

describe('capture-onboarding-overlay.svelte', () => {
  it('is hidden when open is false', async () => {
    render(CaptureOnboardingOverlay, { open: false })
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('renders three steps when a provider is already ready', async () => {
    render(CaptureOnboardingOverlay, { open: true, providerReady: true })
    await expect.element(page.getByText('Step 1 of 3')).toBeInTheDocument()
    await expect.element(page.getByText('Your memory, not theirs.')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Step 2 of 3')).toBeInTheDocument()
    await expect.element(page.getByText('Just drop it in.')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Step 3 of 3')).toBeInTheDocument()
    await expect.element(page.getByText('Stay in the loop')).toBeInTheDocument()
  })

  it('inserts the provider step between capture and notifications when unconfigured', async () => {
    render(CaptureOnboardingOverlay, { open: true, providerReady: false })
    await expect.element(page.getByText('Step 1 of 4')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Step 3 of 4')).toBeInTheDocument()
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await expect.element(page.getByText('OpenRouter')).toBeInTheDocument()
    await expect.element(page.getByText('EUrouter')).toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'API key' })).toBeInTheDocument()

    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Step 4 of 4')).toBeInTheDocument()
    await expect.element(page.getByText('Stay in the loop')).toBeInTheDocument()
  })

  it('shows the operator hint instead of the form when the BYOK UI is disabled', async () => {
    render(CaptureOnboardingOverlay, {
      open: true,
      providerReady: false,
      byokUiEnabled: false,
    })
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    // Hint branch: no provider form controls — the operator configures the server env.
    await expect
      .element(page.getByRole('button', { name: 'Connect provider' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'API key' })).not.toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'Base URL' })).not.toBeInTheDocument()
  })

  it('does not show the provider step once the flow started with a ready provider', async () => {
    render(CaptureOnboardingOverlay, { open: true, providerReady: true })
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Stay in the loop')).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Enable notifications' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Continue without notifications' }))
      .toBeInTheDocument()
  })

  it('offers skip on every step', async () => {
    render(CaptureOnboardingOverlay, { open: true, providerReady: false })
    await expect.element(page.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()
  })

  it('supports stepping back from the provider step', async () => {
    render(CaptureOnboardingOverlay, { open: true, providerReady: false })
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect.element(page.getByText('Step 2 of 4')).toBeInTheDocument()
  })
})
