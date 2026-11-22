import { afterEach, describe, expect, it } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import AppDetail from '../../routes/(nucleus)/m/website/apps/[name]/+page.svelte'

const data = {
  app: {
    name: 'shop',
    kind: 'web',
    repo: 'kindred/shop',
    branch: 'main',
    authKind: 'public',
    autoDeploy: false,
    status: 'healthy',
    shortSha: 'abc1234',
    lastDeployedAt: null,
    lastError: null,
    domains: ['shop.example.com'],
    contractSource: 'form',
    contract: null,
    env: ['SHOP_REGION'],
    mail: { enabled: false },
    history: [],
    catalog: { runtimes: { node: ['22'], static: [] }, services: [], capabilities: [] },
  },
  logs: ['Ready to serve'],
  logsError: null,
  lastDeploy: null,
  nodeVersions: ['22'],
  contractFields: {},
  // Declared + set names (the substrate read); app.env holds the ones with a sealed value.
  secretNames: ['SHOP_REGION', 'SHOP_SECRET'],
  managed: true,
  // Domains are a global setting: the app only shows what points at it (plan/domains-one-claim.md).
  addresses: [{ host: 'shop.example.com', label: 'Live', on: true }],
  addressesError: null,
  howtoUrl: 'https://os.example.com/docs/send-mail.md',
}

function renderDetail() {
  render(AppDetail, { props: { data, form: undefined } as never })
}

afterEach(() => {
  window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}`)
})

describe('app detail settings', () => {
  it('keeps deployment controls visible and opens app configuration from one settings entry', async () => {
    renderDetail()
    await expect.element(page.getByRole('button', { name: 'Redeploy', exact: true })).toBeVisible()
    await expect.element(page.getByText('Ready to serve')).toBeVisible()
    await expect.element(page.getByText('Domains', { exact: true })).not.toBeVisible()
    await page.getByRole('link', { name: 'App settings', exact: true }).click()
    await expect.element(page.getByText('Domains', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Build settings', { exact: true })).toBeVisible()
    // One "Environment variables & secrets" list, each name once: sealed, or declared but unset.
    await expect.element(page.getByText(/^SHOP_REGION\s+sealed$/)).toBeVisible()
    await expect.element(page.getByText(/^SHOP_SECRET\s+needed by the repo, not set$/)).toBeVisible()
    await expect
      .element(page.getByText('Allow this app to send email', { exact: true }))
      .toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Redeploy', exact: true })).toBeVisible()
  })

  it('a link to the app opens app settings, where its address links to Settings › Domains', async () => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#settings`,
    )
    renderDetail()
    await expect.element(page.getByText('Domains', { exact: true })).toBeVisible()
    await expect
      .element(page.getByRole('link', { name: 'Change in Settings › Domains' }))
      .toHaveAttribute('href', '/settings/domains#shop.example.com')
  })
})
