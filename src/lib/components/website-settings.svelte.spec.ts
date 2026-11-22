import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import WebsiteSettings from './website-settings.svelte'

describe('website settings', () => {
  it('makes server setup actionable when deployment is unavailable', async () => {
    render(WebsiteSettings, { data: { managed: false, reason: 'No ee control socket.' } })
    await expect.element(page.getByText('Deployment server not connected')).toBeInTheDocument()
    await expect.element(page.getByText('No ee control socket.')).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'Settings › Domains' }).first())
      .toHaveAttribute('href', '/settings/domains')
    // The tabs above the page hold the area navigation: no "Back to repositories" here.
    await expect
      .element(page.getByRole('link', { name: 'Back to repositories' }))
      .not.toBeInTheDocument()
    await expect.element(page.getByRole('heading', { level: 2, name: 'Settings' })).toBeVisible()
  })

  it('summarises the addresses, links to Settings › Domains and reports real server errors', async () => {
    render(WebsiteSettings, {
      data: {
        managed: true,
        server: {
          consoleHost: 'os.example.org',
          consoleUrl: 'https://os.example.org',
          siteHost: 'example.org',
          appliedRev: 'a'.repeat(40),
          desiredRev: 'b'.repeat(40),
          lastReconcileError: 'Caddy reload failed',
        },
        domains: { total: 3, console: 1, site: 1, apps: 1, calls: 0 },
      },
    })
    await expect.element(page.getByText('Caddy reload failed')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('hosting-domains'))
      .toHaveTextContent(
        '3 addresses point at this server: the console, the company website and 1 app.',
      )
    await expect
      .element(
        page.getByTestId('hosting-domains').getByRole('link', { name: 'Settings › Domains' }),
      )
      .toHaveAttribute('href', '/settings/domains')
  })
})
