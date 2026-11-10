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
  // declared + set names (loader); app.env holds the set ones → SHOP_SECRET is declared, not set
  secretNames: ['SHOP_REGION', 'SHOP_SECRET'],
  managed: true,
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
    await expect.element(page.getByText('Domains & routing', { exact: true })).not.toBeVisible()
    await page.getByRole('link', { name: 'App settings', exact: true }).click()
    await expect.element(page.getByText('Domains & routing', { exact: true })).toBeVisible()
    await expect.element(page.getByText('Build settings', { exact: true })).toBeVisible()
    await expect.element(page.getByText(/^SHOP_REGION\s+sealed$/)).toBeVisible()
    await expect
      .element(page.getByText(/^SHOP_SECRET\s+needed by the repo, not set$/))
      .toBeVisible()
    await expect
      .element(page.getByText('Allow this app to send email', { exact: true }))
      .toBeVisible()
    await expect.element(page.getByRole('button', { name: 'Redeploy', exact: true })).toBeVisible()
  })

  it('a domain owner link opens directly to app settings', async () => {
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}${window.location.search}#settings`,
    )
    renderDetail()
    await expect.element(page.getByText('Domains & routing', { exact: true })).toBeVisible()
    await expect
      .element(page.getByRole('link', { name: 'HTTPS & certificate settings' }))
      .toHaveAttribute('href', '/m/website/settings#https')
  })
})
