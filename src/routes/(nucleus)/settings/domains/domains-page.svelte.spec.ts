import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import DomainsPage from './+page.svelte'

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))

const REGISTRANT = { firstName: 'Ada', lastName: 'Lovelace', organization: 'Acme GmbH', email: 'ada@acme.test' }

const rows = [
  {
    name: 'acme.eu',
    source: 'bought',
    state: 'active',
    error: null,
    renewsAt: '2027-11-18T00:00:00.000Z',
    autoRenew: true,
    mail: { id: 'd1', name: 'acme.eu', status: 'SUCCESS', sendable: true, receiving: true },
    mailNote: null,
  },
  {
    name: 'acme.test',
    source: 'connected',
    state: null,
    error: null,
    renewsAt: null,
    autoRenew: null,
    mail: { id: 'd2', name: 'acme.test', status: 'PENDING', sendable: false, receiving: false },
    mailNote: null,
  },
]

const props = (data: Record<string, unknown>) => ({ data, form: null, params: {} }) as never

describe('Settings › Domains', () => {
  it('lists bought and connected domains with state, renewal and their DNS records', async () => {
    render(DomainsPage, props({ canBuy: true, boughtError: null, rows, registrant: REGISTRANT }))
    await expect.element(page.getByText('acme.eu')).toBeInTheDocument()
    await expect.element(page.getByText(/Bought through eigenEnterprise · Renews/)).toBeInTheDocument()
    await expect.element(page.getByTestId('domain-state')).toHaveTextContent('Ready')
    await expect.element(page.getByText('In your own DNS')).toBeInTheDocument()
    await expect
      .element(page.getByRole('link', { name: 'DNS records' }).first())
      .toHaveAttribute('href', '/m/email/domains/d1')
  })

  it('buying opens the same buy flow as the onboarding, prefilled from the company', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ results: [{ name: 'acme.eu', available: true, priceCents: 1200, currency: 'EUR' }] }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(DomainsPage, props({ canBuy: true, boughtError: null, rows: [], registrant: REGISTRANT }))
    await page.getByTestId('domains-buy').click()
    await page.getByRole('textbox', { name: 'The name you want' }).fill('acme')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByRole('button', { name: 'Choose acme.eu' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Company' })).toHaveValue('Acme GmbH')
    vi.unstubAllGlobals()
  })

  it('self-hosted: no buying, only connecting; a control plane outage shows in plain words', async () => {
    render(DomainsPage, props({ canBuy: false, boughtError: 'The domain service failed (HTTP 503).', rows: [], registrant: null }))
    await expect.element(page.getByTestId('domains-buy')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('domains-connect')).toBeInTheDocument()
    await expect.element(page.getByText('Buying a domain works on servers hosted by eigenEnterprise.')).toBeInTheDocument()
    await expect.element(page.getByText('The domain service failed (HTTP 503).')).toBeInTheDocument()
  })
})
