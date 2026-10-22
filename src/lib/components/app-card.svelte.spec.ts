import { describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AppCard from './app-card.svelte'

const fiveMinutesAgo = () => new Date(Date.now() - 5 * 60_000).toISOString()

describe('app-card: an app', () => {
  it('links the whole card, badges the kind and shows the deploy state', async () => {
    render(AppCard, {
      props: {
        name: 'shop',
        kind: 'web',
        state: 'healthy',
        domains: ['shop.kindred.dev'],
        url: 'https://shop.kindred.dev',
        href: '/m/website/apps/shop',
      },
    })
    await expect
      .element(page.getByTestId('app-card-link'))
      .toHaveAttribute('href', '/m/website/apps/shop')
    await expect.element(page.getByText('Web app')).toBeInTheDocument()
    await expect.element(page.getByText('Healthy')).toBeInTheDocument()
  })

  it('shows each domain as an outbound link (the first on its url) beside the card link', async () => {
    render(AppCard, {
      props: {
        name: 'shop',
        kind: 'web',
        state: 'healthy',
        domains: ['shop.kindred.dev', 'shop2.kindred.dev'],
        url: 'https://shop.kindred.dev',
        href: '/m/website/apps/shop',
      },
    })
    const first = page.getByRole('link', { name: 'shop.kindred.dev' })
    await expect.element(first).toHaveAttribute('href', 'https://shop.kindred.dev')
    await expect.element(first).toHaveAttribute('target', '_blank')
    await expect
      .element(page.getByRole('link', { name: 'shop2.kindred.dev' }))
      .toHaveAttribute('href', 'https://shop2.kindred.dev')
  })

  it('says where the app comes from and how its last deploy went', async () => {
    render(AppCard, {
      props: {
        name: 'shop',
        kind: 'web',
        state: 'failed',
        domains: [],
        url: null,
        repo: 'kindred/shop',
        branch: 'main',
        rev: 'ccccccc',
        lastDeploy: {
          status: 'failed',
          stage: 'failed',
          startedAt: fiveMinutesAgo(),
          endedAt: fiveMinutesAgo(),
        },
        href: '/m/website/apps/shop',
      },
    })
    await expect.element(page.getByText('kindred/shop · main@ccccccc')).toBeInTheDocument()
    await expect.element(page.getByText(/Last deploy: Failed · 5 minutes ago/)).toBeInTheDocument()
    await expect.element(page.getByText('Failed', { exact: true })).toBeInTheDocument()
  })

  it('a running deploy says so; a back-end service shows no domain', async () => {
    render(AppCard, {
      props: {
        name: 'worker',
        kind: 'backend',
        state: 'deploying',
        domains: [],
        url: null,
        repo: 'kindred/worker',
        branch: 'main',
        rev: null,
        lastDeploy: {
          status: 'running',
          stage: 'building',
          startedAt: fiveMinutesAgo(),
          endedAt: null,
        },
        href: '/m/website/apps/worker',
      },
    })
    await expect.element(page.getByText('Service')).toBeInTheDocument()
    await expect.element(page.getByText('Deploying', { exact: true })).toBeInTheDocument()
    await expect
      .element(page.getByText(/Last deploy: Deploying · 5 minutes ago/))
      .toBeInTheDocument()
    expect((await page.getByTestId('app-card-domain').elements()).length).toBe(0)
  })
})

describe('app-card: the company site', () => {
  it('shows its domain, the page counts and no deploy state', async () => {
    render(AppCard, {
      props: {
        name: 'Company site',
        kind: 'site',
        domains: ['kindred.digital'],
        url: 'https://kindred.digital',
        href: '/m/website/site',
        pages: { published: 2, drafts: 1 },
      },
    })
    await expect.element(page.getByText('Site', { exact: true })).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'kindred.digital' }))
      .toHaveAttribute('href', 'https://kindred.digital')
    await expect.element(page.getByText('2 pages published · 1 draft')).toBeInTheDocument()
    expect((await page.getByText('Healthy').elements()).length).toBe(0)
  })

  it('without a domain yet it says so plainly', async () => {
    render(AppCard, {
      props: {
        name: 'Company site',
        kind: 'site',
        domains: [],
        url: null,
        href: '/m/website/site',
        pages: { published: 0, drafts: 0 },
      },
    })
    await expect.element(page.getByText('No domain yet')).toBeInTheDocument()
    await expect.element(page.getByText('0 pages published · 0 drafts')).toBeInTheDocument()
  })
})

describe('app-card: connected repositories and unavailable deployment servers', () => {
  it('makes a private repository actionable before it has an app', async () => {
    render(AppCard, {
      props: {
        name: 'kindred/dashboard',
        kind: 'repository',
        domains: [],
        url: null,
        repo: 'kindred/dashboard',
        branch: 'main',
        visibility: 'private',
        authKind: 'deploy_key',
        href: '/m/website/apps/new?repo=kindred%2Fdashboard&branch=main',
      },
    })
    await expect.element(page.getByText('Repository', { exact: true })).toBeInTheDocument()
    await expect.element(page.getByText('Private · Deploy key')).toBeInTheDocument()
    await expect.element(page.getByText('Ready to configure')).toBeInTheDocument()
    await expect
      .element(page.getByTestId('app-card-link'))
      .toHaveAttribute('href', '/m/website/apps/new?repo=kindred%2Fdashboard&branch=main')
  })

  it('does not show a stale healthy status when the server is unavailable', async () => {
    render(AppCard, {
      props: {
        name: 'shop',
        kind: 'web',
        state: 'healthy',
        managed: false,
        domains: [],
        url: null,
        href: '/m/website/apps/shop',
      },
    })
    await expect.element(page.getByText('Server not connected')).toBeInTheDocument()
    expect(page.getByText('Healthy', { exact: true }).query()).toBeNull()
  })
})
