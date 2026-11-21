import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRole } from '$lib/server/auth/roles'
import { FakeControlPlane } from './fake-control-plane'
import { DOMAINS_FORBIDDEN, DOMAINS_NOT_HERE, domainsRoutes } from './http'

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

function ev(opts: { user?: boolean; path?: string; body?: unknown } = {}) {
  const url = new URL(`https://os.test${opts.path ?? '/api/domains'}`)
  return {
    locals: (opts.user === false
      ? {}
      : { user: { id: 'u1', email: 'ada@acme.test' } }) as App.Locals,
    url,
    request: new Request(
      url,
      opts.body === undefined ? {} : { method: 'POST', body: JSON.stringify(opts.body) },
    ),
  }
}

describe('domains session routes', () => {
  let cp: FakeControlPlane
  let role: MemberRole | null
  let configured: boolean
  const routes = () =>
    domainsRoutes({
      role: vi.fn(async () => role),
      config: () => (configured ? cp.config() : null),
      fetch: cp.fetch,
    })

  beforeEach(() => {
    cp = new FakeControlPlane()
    cp.results = [{ name: 'acme.eu', available: true, priceCents: 1200, currency: 'EUR' }]
    role = 'owner'
    configured = true
  })

  it('signed out → 401; a member → 403; the control plane is never asked', async () => {
    expect((await routes().list(ev({ user: false }))).status).toBe(401)
    role = 'member'
    const res = await routes().search(ev({ path: '/api/domains/search?q=acme' }))
    expect(res.status).toBe(403)
    const refused = await res.json()
    expect(refused.error).toBe(DOMAINS_FORBIDDEN)
    expect(refused.agent).toMatchObject({
      attempted: 'Managing the company’s domains',
      cause: expect.stringContaining('company.manage'),
    })
    expect(cp.seenAuth).toEqual([])
  })

  it('admins may buy too', async () => {
    role = 'admin'
    expect((await routes().search(ev({ path: '/api/domains/search?q=acme' }))).status).toBe(200)
  })

  it('list: canBuy false and no call without EE_DOMAINS_* (self-hosted)', async () => {
    configured = false
    expect(await (await routes().list(ev())).json()).toEqual({ canBuy: false, domains: [] })
    expect(cp.seenAuth).toEqual([])
  })

  it('list: the control plane’s domains, never the token', async () => {
    cp.domains = [
      { name: 'acme.eu', state: 'registering', error: null, renewsAt: null, autoRenew: true },
    ]
    const res = await routes().list(ev())
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({ canBuy: true, domains: cp.domains })
    expect(text).not.toContain(cp.token)
  })

  it('search: results with their yearly price; a bad query is a 400 in plain words', async () => {
    expect(
      await (await routes().search(ev({ path: '/api/domains/search?q=acme' }))).json(),
    ).toEqual({ results: cp.results })
    const bad = await routes().search(ev({ path: '/api/domains/search?q=acme.eu' }))
    expect(bad.status).toBe(400)
    const badBody = await bad.json()
    expect(badBody.error).toMatch(/without the ending/)
    expect(badBody.agent).toMatchObject({
      attempted: 'The search',
      code: 'DomainsApiError',
      details: { status: 400 },
    })
  })

  it('search and purchase without EE_DOMAINS_*: 404 saying buying isn’t offered here', async () => {
    configured = false
    const res = await routes().search(ev({ path: '/api/domains/search?q=acme' }))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe(DOMAINS_NOT_HERE)
    expect(body.agent.cause).toContain('EE_DOMAINS_')
    expect((await routes().purchase(ev({ body: {} }))).status).toBe(404)
  })

  it('purchase: 202 with the state; the control plane gets name, accepted price and registrant', async () => {
    const res = await routes().purchase(
      ev({
        path: '/api/domains/purchases',
        body: { name: 'acme.eu', acceptedPriceCents: 1200, registrant },
      }),
    )
    expect(res.status).toBe(202)
    expect(await res.json()).toEqual({ name: 'acme.eu', state: 'charging' })
    expect(cp.purchases).toEqual([{ name: 'acme.eu', acceptedPriceCents: 1200, registrant }])
  })

  it('purchase: an invalid registrant is refused before the control plane is asked', async () => {
    const res = await routes().purchase(
      ev({
        path: '/api/domains/purchases',
        body: {
          name: 'acme.eu',
          acceptedPriceCents: 1200,
          registrant: { ...registrant, phone: '030 1234567' },
        },
      }),
    )
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/country code/)
    expect(cp.purchases).toEqual([])
  })

  it('purchase: 402 keeps the control plane’s status and words', async () => {
    cp.purchaseRefusal = { status: 402, body: { error: 'Add a payment method first.' } }
    const res = await routes().purchase(
      ev({
        path: '/api/domains/purchases',
        body: { name: 'acme.eu', acceptedPriceCents: 1200, registrant },
      }),
    )
    expect(res.status).toBe(402)
    const body = await res.json()
    expect(body.error).toBe('Add a payment method first.')
    expect(body.agent).toMatchObject({ attempted: 'Buying the domain', details: { status: 402 } })
  })

  it('purchase: a 409 hands the browser the reason and the current price', async () => {
    const body = {
      error: 'The price of acme.eu changed.',
      reason: 'price_changed',
      priceCents: 1400,
    }
    cp.purchaseRefusal = { status: 409, body }
    const res = await routes().purchase(
      ev({
        path: '/api/domains/purchases',
        body: { name: 'acme.eu', acceptedPriceCents: 1200, registrant },
      }),
    )
    expect(res.status).toBe(409)
    const answer = await res.json()
    expect({ error: answer.error, reason: answer.reason, priceCents: answer.priceCents }).toEqual(
      body,
    )
    expect(answer.agent).toMatchObject({ attempted: 'Buying the domain', details: { status: 409 } })
  })

  it('purchase: a body that is not JSON is a 400', async () => {
    const e = ev({ path: '/api/domains/purchases' })
    const res = await routes().purchase({
      ...e,
      request: new Request(e.url, { method: 'POST', body: 'nope' }),
    })
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('Request body must be JSON.')
  })
})
