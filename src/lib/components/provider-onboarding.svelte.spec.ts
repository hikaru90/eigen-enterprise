import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'

vi.mock('$lib/analytics/posthog-client', () => ({
  capture: () => undefined,
}))

import ProviderOnboarding from './provider-onboarding.svelte'

describe('provider-onboarding.svelte', () => {
  it('opens on provider choice with the connect action', async () => {
    render(ProviderOnboarding, { byokUiEnabled: true })
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'OpenRouter' })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'EUrouter' })).toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'API key' })).toBeInTheDocument()
    await expect.element(page.getByRole('button', { name: 'Connect' })).toBeEnabled()
  })

  it('swaps credential fields with the provider choice', async () => {
    render(ProviderOnboarding, { byokUiEnabled: true })
    await expect.element(page.getByRole('textbox', { name: 'Chat model' })).toBeInTheDocument()
    await expect
      .element(page.getByRole('textbox', { name: 'Chat routing rule ID' }))
      .not.toBeInTheDocument()

    await page.getByRole('button', { name: 'EUrouter' }).click()
    await expect
      .element(page.getByRole('textbox', { name: 'Chat routing rule ID' }))
      .toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'Chat model' })).not.toBeInTheDocument()
  })

  it('shows the operator hint instead of the form when the BYOK UI is disabled', async () => {
    render(ProviderOnboarding, { byokUiEnabled: false })
    await expect.element(page.getByText('Connect your AI provider.')).toBeInTheDocument()
    await expect
      .element(page.getByRole('button', { name: 'Connect' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByRole('textbox', { name: 'API key' })).not.toBeInTheDocument()
  })
})
