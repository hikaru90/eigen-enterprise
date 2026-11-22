import type { DomainsList, HostView } from '../../../../../modules/domains/view'
import { describe, expect, it, vi } from 'vitest'
import { render } from 'vitest-browser-svelte'
import { page } from 'vitest/browser'
import DomainsPage from './+page.svelte'

vi.mock('$app/navigation', () => ({ invalidateAll: vi.fn() }))
vi.mock('$app/paths', () => ({ base: '', resolve: (path: string) => path }))
vi.mock('$app/forms', () => ({ enhance: () => ({ destroy: () => undefined }) }))

const REGISTRANT = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  organization: 'Acme GmbH',
  email: 'ada@acme.test',
}
const BOX = '203.0.113.7'

const apex: HostView = {
  host: 'acme.eu',
  shows: { kind: 'site' },
  email: { sending: true, receiving: true },
  records: [
    {
      name: 'acme.eu',
      type: 'A',
      value: BOX,
      purpose: 'web',
      status: 'ok',
      observed: [BOX],
      error: null,
    },
    {
      name: '_dmarc.acme.eu',
      type: 'TXT',
      value: 'v=DMARC1; p=none;',
      purpose: 'mail_dmarc',
      status: 'missing',
      observed: [],
      error: null,
    },
  ],
  claim: { verified: true },
  certificate: {
    host: 'acme.eu',
    state: 'issued',
    lastError: null,
    nextRetryAt: null,
    notAfter: '2027-02-01T00:00:00.000Z',
  },
}
const shop: HostView = {
  host: 'shop.acme.eu',
  shows: { kind: 'app', app: 'shop' },
  email: null,
  records: [
    {
      name: 'shop.acme.eu',
      type: 'A',
      value: BOX,
      purpose: 'web',
      status: 'wrong',
      observed: ['198.51.100.1'],
      error: null,
    },
    {
      name: '_ee-verify.shop.acme.eu',
      type: 'TXT',
      value: 'tok-1',
      purpose: 'claim',
      status: 'ok',
      observed: ['tok-1'],
      error: null,
    },
  ],
  claim: { verified: false },
  certificate: {
    host: 'shop.acme.eu',
    state: 'failing',
    lastError: 'acme: NXDOMAIN looking up A for shop.acme.eu',
    nextRetryAt: '2026-11-22T10:00:00.000Z',
    notAfter: null,
  },
}
const calls: HostView = {
  host: 'rtc.one.acme.eu',
  shows: { kind: 'calls' },
  email: null,
  records: [],
  claim: null,
  certificate: null,
}

const list = (o: Partial<DomainsList> = {}): DomainsList => ({
  managed: true,
  reason: null,
  apps: ['shop'],
  errors: [],
  domains: [
    {
      name: 'acme.eu',
      source: 'bought',
      bought: {
        state: 'active',
        error: null,
        renewsAt: '2027-11-18T00:00:00.000Z',
        autoRenew: true,
      },
      hosts: [apex, calls, shop],
    },
    { name: 'acme.test', source: 'connected', bought: null, hosts: [] },
  ],
  ...o,
})

const props = (data: Record<string, unknown>, form: unknown = null) =>
  ({
    data: {
      canBuy: true,
      listError: null,
      mailNotes: {},
      registrant: REGISTRANT,
      list: list(),
      ...data,
    },
    form,
    params: {},
  }) as never

describe('Settings › Domains — the one place', () => {
  it('each domain with its source and renewal, its hostnames with shows, email, DNS, claim, certificate', async () => {
    render(DomainsPage, props({}))
    const sections = page.getByTestId('domain-section')
    await expect.element(sections.first()).toHaveAccessibleName('acme.eu')
    await expect
      .element(page.getByText(/Bought through eigenEnterprise · Renews/))
      .toBeInTheDocument()
    await expect.element(page.getByText('In your own DNS')).toBeInTheDocument()
    await expect.element(page.getByTestId('host-row')).toHaveLength(3)

    const apexRow = page.getByTestId('host-row').nth(0)
    await expect.element(apexRow).toHaveAttribute('id', 'acme.eu')
    await expect
      .element(apexRow.getByRole('combobox', { name: 'What acme.eu shows' }))
      .toHaveValue('site')
    await expect.element(apexRow.getByTestId('host-email')).toHaveTextContent('Sending · Receiving')
    await expect.element(apexRow.getByTestId('host-dns')).toHaveTextContent('1 to fix')
    await expect.element(apexRow.getByTestId('host-claim')).toHaveTextContent('Verified')
    await expect.element(apexRow.getByTestId('host-certificate')).toHaveTextContent(/Issued until/)

    // Calls is shown, never picked.
    const callsRow = page.getByTestId('host-row').nth(1)
    await expect.element(callsRow.getByTestId('host-shows')).toHaveTextContent('Calls')

    const shopRow = page.getByTestId('host-row').nth(2)
    await expect
      .element(shopRow.getByTestId('host-claim'))
      .toHaveTextContent('Waiting for the TXT record')
    await expect.element(shopRow.getByTestId('host-certificate')).toHaveTextContent(/Failing/)
    await expect.element(shopRow.getByTestId('host-certificate')).toHaveTextContent(/NXDOMAIN/)
    await expect
      .element(shopRow.getByRole('button', { name: 'Retry certificate' }))
      .toBeInTheDocument()
  })

  it('records to add: only the missing and wrong ones, copyable, with what DNS shows now', async () => {
    render(DomainsPage, props({}))
    const block = page.getByTestId('records-to-add')
    await expect.element(block.getByTestId('record-to-add')).toHaveLength(2)
    await expect.element(block.getByText('_dmarc.acme.eu')).toBeInTheDocument()
    await expect.element(block.getByText('_ee-verify.shop.acme.eu')).not.toBeInTheDocument()
    await expect
      .element(block.getByTestId('record-observed'))
      .toHaveTextContent('DNS shows now: 198.51.100.1.')
    await expect
      .element(block.getByRole('button', { name: 'Copy the value of the TXT record' }))
      .toBeInTheDocument()
  })

  it('changing what a host shows asks first, naming what it shows now', async () => {
    render(DomainsPage, props({}))
    await page.getByRole('combobox', { name: 'What acme.eu shows' }).selectOptions('app:shop')
    await expect
      .element(page.getByTestId('shows-confirm'))
      .toHaveTextContent('acme.eu shows company website now. Show app shop instead?')
    await page.getByRole('button', { name: 'Cancel' }).click()
    await expect.element(page.getByTestId('shows-confirm')).not.toBeInTheDocument()
  })

  it('add a hostname under each domain; the tool’s answer is shown', async () => {
    render(
      DomainsPage,
      props(
        {},
        {
          action: 'addHost',
          ok: true,
          host: 'www.acme.eu',
          message: 'www.acme.eu now shows the company website.',
          reconcileError: null,
        },
      ),
    )
    await expect.element(page.getByTestId('add-host').first()).toBeInTheDocument()
    await expect
      .element(page.getByRole('textbox', { name: 'New hostname under acme.eu' }))
      .toBeInTheDocument()
    await expect
      .element(page.getByTestId('domains-answer'))
      .toHaveTextContent('www.acme.eu now shows the company website.')
  })

  it('a refused action shows its plain sentence and the agent instructions', async () => {
    render(
      DomainsPage,
      props(
        {},
        {
          action: 'remove',
          host: 'one.acme.eu',
          error: 'one.acme.eu is the console address and cannot be removed.',
          agent: { attempted: 'Removing one.acme.eu', nextSteps: ['x'] },
        },
      ),
    )
    await expect.element(page.getByRole('alert')).toHaveTextContent(/cannot be removed/)
    await expect
      .element(page.getByRole('button', { name: 'Copy agent instructions' }))
      .toBeInTheDocument()
  })

  it('a failed source is loud but local: the rest of the page still shows', async () => {
    render(
      DomainsPage,
      props({
        canBuy: false,
        list: list({
          errors: [
            {
              source: 'bought',
              error: 'The domain service failed (HTTP 503).',
              agent: {
                attempted: 'Listing the domains bought through eigenEnterprise',
                nextSteps: ['Check the control plane.'],
              },
            },
          ],
        }),
      }),
    )
    await expect
      .element(page.getByTestId('domains-error-bought'))
      .toHaveTextContent('The domain service failed (HTTP 503).')
    await expect.element(page.getByTestId('host-row').first()).toBeInTheDocument()
    await expect.element(page.getByTestId('domains-buy')).not.toBeInTheDocument()
    await expect
      .element(page.getByText('Buying a domain works on servers hosted by eigenEnterprise.'))
      .toBeInTheDocument()
  })

  it('not under ee: no pickers, the reason said plainly', async () => {
    render(
      DomainsPage,
      props({
        list: list({ managed: false, reason: 'This copy is not running under ee.', apps: [] }),
      }),
    )
    await expect
      .element(page.getByTestId('domains-unmanaged'))
      .toHaveTextContent(/not running under ee/)
    await expect.element(page.getByRole('combobox')).not.toBeInTheDocument()
    await expect.element(page.getByTestId('add-host')).not.toBeInTheDocument()
  })

  it('buying opens the same buy flow as the onboarding; connecting says it adds the domain for email', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        results: [{ name: 'acme.eu', available: true, priceCents: 1200, currency: 'EUR' }],
      }),
    }))
    vi.stubGlobal('fetch', fetchMock)
    render(DomainsPage, props({ list: list({ domains: [] }) }))
    await expect.element(page.getByText('No domains yet.')).toBeInTheDocument()
    await page.getByTestId('domains-buy').click()
    await page.getByRole('textbox', { name: 'The name you want' }).fill('acme')
    await page.getByRole('button', { name: 'Search' }).click()
    await page.getByRole('button', { name: 'Choose acme.eu' }).click()
    await expect.element(page.getByRole('textbox', { name: 'Company' })).toHaveValue('Acme GmbH')
    vi.unstubAllGlobals()
    await page.getByTestId('domains-connect').click()
    await expect
      .element(page.getByTestId('domains-connect-note'))
      .toHaveTextContent('adds it for email; add hostnames below to use it for the website or apps')
  })
})
