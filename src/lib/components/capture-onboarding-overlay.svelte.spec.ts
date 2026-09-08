import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

vi.mock('$lib/analytics/posthog-client', () => ({
  capture: () => undefined,
}))

import CaptureOnboardingOverlay from './capture-onboarding-overlay.svelte'

describe('capture-onboarding-overlay.svelte', () => {
  it('is hidden when open is false', async () => {
    render(CaptureOnboardingOverlay, { open: false })
    await expect.element(page.getByRole('dialog')).not.toBeInTheDocument()
  })

  it('walks welcome → capture → notifications in three steps', async () => {
    render(CaptureOnboardingOverlay, { open: true })
    await expect.element(page.getByText('Step 1 of 3')).toBeInTheDocument()
    await expect.element(page.getByText('Your memory, not theirs.')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Skip for now' })).toBeInTheDocument()

    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Step 2 of 3')).toBeInTheDocument()
    await expect.element(page.getByText('Just drop it in.')).toBeInTheDocument()

    await page.getByRole('button', { name: 'Next' }).click()
    await expect.element(page.getByText('Step 3 of 3')).toBeInTheDocument()
    await expect.element(page.getByText('Stay in the loop')).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Enable notifications' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Continue without notifications' }))
      .toBeInTheDocument()
  })

  it('supports stepping back', async () => {
    render(CaptureOnboardingOverlay, { open: true })
    await page.getByRole('button', { name: 'Next' }).click()
    await page.getByRole('button', { name: 'Back' }).click()
    await expect.element(page.getByText('Step 1 of 3')).toBeInTheDocument()
  })

  it('carries no legacy install or wallet surface', async () => {
    render(CaptureOnboardingOverlay, { open: true })
    await expect.element(page.getByText(/Install Eigen Mesh/i)).not.toBeInTheDocument()
    await expect.element(page.getByText(/PayPal/i)).not.toBeInTheDocument()
    await expect.element(page.getByText('API key')).not.toBeInTheDocument()
  })
})
