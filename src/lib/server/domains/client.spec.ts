import { beforeEach, describe, expect, it } from 'vitest'
import { DomainsApiError, domainsClient } from './client'
import { FakeControlPlane } from './fake-control-plane'

const registrant = {
  firstName: 'Ada',
  lastName: 'Lovelace',
  organization: 'Acme GmbH',
  email: 'ada@acme.test',
  phone: '+49.301234567',
  addressLine1: 'Hauptstr. 1',
  city: 'Berlin',
  postalCode: '10115',
  countryCode: 'DE',
}

describe('domainsClient (control plane domains API)', () => {
  let cp: FakeControlPlane
  beforeEach(() => {
    cp = new FakeControlPlane()
    cp.results = [
      { name: 'acme.eu', available: true, priceCents: 1200, currency: 'EUR' },
      { name: 'acme.com', available: false, priceCents: null, currency: 'EUR' },
    ]
  })

  it('search sends the bearer token and returns the typed results', async () => {
    const out = await domainsClient(cp.config(), cp.fetch).search('acme')
    expect(out).toEqual(cp.results)
    expect(cp.seenAuth).toEqual([`Bearer ${cp.token}`])
  })

  it('search refuses a query that is not one label, before calling', async () => {
    const client = domainsClient(cp.config(), cp.fetch)
    await expect(client.search('acme.eu')).rejects.toThrow(/without the ending/)
    await expect(client.search('')).rejects.toThrow(DomainsApiError)
    expect(cp.seenAuth).toEqual([])
  })

  it('search lowercases and trims what the person typed', async () => {
    expect(await domainsClient(cp.config(), cp.fetch).search('  Acme ')).toHaveLength(2)
  })

  it('purchase posts name, accepted price and registrant; answers the state', async () => {
    const out = await domainsClient(cp.config(), cp.fetch).purchase({ name: 'acme.eu', acceptedPriceCents: 1200, registrant })
    expect(out).toEqual({ name: 'acme.eu', state: 'charging' })
    expect(cp.purchases).toEqual([{ name: 'acme.eu', acceptedPriceCents: 1200, registrant }])
  })

  it.each([
    [402, 'Add a payment method first (Settings › Billing).'],
    [400, 'postalCode is invalid.'],
  ])('a %i keeps its status and the control plane’s words', async (status, error) => {
    cp.purchaseRefusal = { status, body: { error } }
    const err = await domainsClient(cp.config(), cp.fetch)
      .purchase({ name: 'acme.eu', acceptedPriceCents: 1200, registrant })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(DomainsApiError)
    expect(err).toMatchObject({ status, message: error, conflict: null })
  })

  it.each([
    [{ error: 'acme.eu was just taken.', reason: 'taken', priceCents: null }],
    [{ error: 'The price of acme.eu changed.', reason: 'price_changed', priceCents: 1400 }],
  ])('a 409 carries its reason and the current price as fields', async (body) => {
    cp.purchaseRefusal = { status: 409, body }
    const err = await domainsClient(cp.config(), cp.fetch)
      .purchase({ name: 'acme.eu', acceptedPriceCents: 1200, registrant })
      .catch((e: unknown) => e)
    expect(err).toMatchObject({ status: 409, message: body.error, conflict: body })
  })

  it('a 409 without a reason fails loud instead of guessing from the words', async () => {
    cp.purchaseRefusal = { status: 409, body: { error: 'acme.eu was just taken.' } }
    await expect(
      domainsClient(cp.config(), cp.fetch).purchase({ name: 'acme.eu', acceptedPriceCents: 1200, registrant }),
    ).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/without saying why/) })
  })

  it('list returns the company’s domains', async () => {
    cp.domains = [{ name: 'acme.eu', state: 'active', error: null, renewsAt: '2027-11-18T00:00:00.000Z', autoRenew: true }]
    expect(await domainsClient(cp.config(), cp.fetch).list()).toEqual(cp.domains)
  })

  it('an unexpected answer shape fails loud, never a guess', async () => {
    cp.broken = { status: 200, body: { domains: [{ name: 'acme.eu', state: 'parked' }] } }
    await expect(domainsClient(cp.config(), cp.fetch).list()).rejects.toThrow(/unexpected answer/)
  })

  it('an error without a body names the status in plain words', async () => {
    cp.broken = { status: 503, body: null }
    await expect(domainsClient(cp.config(), cp.fetch).list()).rejects.toMatchObject({
      status: 502,
      message: expect.stringMatching(/HTTP 503/),
    })
  })

  it('an unreachable control plane says so', async () => {
    const client = domainsClient({ apiBase: 'https://elsewhere.test', token: cp.token }, cp.fetch)
    await expect(client.list()).rejects.toMatchObject({ status: 502, message: expect.stringMatching(/could not reach/i) })
  })

  it('a refused token is not echoed back in the error', async () => {
    const err = (await domainsClient({ apiBase: cp.origin, token: 'wrong-token' }, cp.fetch)
      .list()
      .catch((e: unknown) => e)) as Error
    expect(err.message).not.toContain('wrong-token')
    expect(err).toMatchObject({ status: 502 })
  })
})
