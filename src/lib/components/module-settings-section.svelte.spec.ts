import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import ModuleSettingsSection from './module-settings-section.svelte'

describe('module-settings-section.svelte', () => {
  it('renders the links a module put in its slot', async () => {
    render(ModuleSettingsSection, {
      slot: {
        links: [
          { label: 'Hosting settings', href: '/m/website/settings', text: 'Domains and apps.' },
        ],
      },
    })
    await expect
      .element(page.getByRole('link', { name: /Hosting settings/ }))
      .toHaveAttribute('href', '/m/website/settings')
    await expect.element(page.getByText('Domains and apps.')).toBeInTheDocument()
  })

  it('shows the slot note', async () => {
    render(ModuleSettingsSection, { slot: { note: 'Set up in the welcome flow.', links: [] } })
    await expect.element(page.getByText('Set up in the welcome flow.')).toBeInTheDocument()
  })

  it('says so when a module has no settings', async () => {
    render(ModuleSettingsSection, { slot: null })
    await expect.element(page.getByTestId('module-settings-empty')).toHaveTextContent('no settings')
  })
})
