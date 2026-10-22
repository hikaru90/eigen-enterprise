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
      .element(page.getByRole('link', { name: 'Company site settings', exact: true }))
      .toHaveAttribute('href', '/m/website/site')
    await expect
      .element(page.getByRole('link', { name: 'Back to repositories' }))
      .toHaveAttribute('href', '/m/website')
    await expect.element(page.getByText(/Certificate status is not reported/)).toBeInTheDocument()
  })

  it('links domain routing to app settings and reports real server errors', async () => {
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
        domains: [
          {
            host: 'shop.example.org',
            url: 'https://shop.example.org',
            role: 'App',
            owner: { kind: 'app', name: 'shop', href: '/m/website/apps/shop' },
          },
        ],
      },
    })
    await expect.element(page.getByText('Caddy reload failed')).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'shop', exact: true }))
      .toHaveAttribute('href', '/m/website/apps/shop#settings')
    await expect
      .element(page.getByRole('link', { name: 'shop.example.org' }))
      .toHaveAttribute('href', 'https://shop.example.org')
    await expect.element(page.getByText(/Certificate status is not reported/)).toBeInTheDocument()
  })
})
