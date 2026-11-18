import type { BoughtDomain, DomainSearchResult, PurchaseRequest } from '$lib/domains/contract'

/**
 * A fake of the control plane's domains API (plan/managed-domains.md,
 * Contract) for tests: a `fetch` that answers the three routes the way DM3
 * will, checks the bearer token, and records what it was sent.
 */
export class FakeControlPlane {
  readonly origin = 'https://cloud.fake.test'
  readonly token = 'box-token-0123456789abcdef0123456789'
  results: DomainSearchResult[] = []
  domains: BoughtDomain[] = []
  purchases: PurchaseRequest[] = []
  seenAuth: (string | null)[] = []
  /** Set to answer the next purchase with this status + body (409 { error, reason, priceCents } / 402 / 400 { error }). */
  purchaseRefusal: { status: number; body: Record<string, unknown> } | null = null
  /** Set to make every call answer this (an outage, or a broken shape). */
  broken: { status: number; body: unknown } | null = null

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const headers = new Headers(init?.headers)
    this.seenAuth.push(headers.get('authorization'))
    if (url.origin !== this.origin) throw new TypeError(`fetch failed: ${url.origin} is not the fake control plane`)
    if (headers.get('authorization') !== `Bearer ${this.token}`) return Response.json({ error: 'Unknown box token.' }, { status: 401 })
    if (this.broken) return Response.json(this.broken.body, { status: this.broken.status })
    const method = init?.method ?? 'GET'
    if (method === 'GET' && url.pathname === '/api/domains/v1/search') {
      const q = url.searchParams.get('q') ?? ''
      if (!/^[a-z0-9-]{1,63}$/.test(q)) return Response.json({ error: 'q must be one label.' }, { status: 400 })
      return Response.json({ results: this.results.filter((r) => r.name.startsWith(`${q}.`)) })
    }
    if (method === 'GET' && url.pathname === '/api/domains/v1/domains') return Response.json({ domains: this.domains })
    if (method === 'POST' && url.pathname === '/api/domains/v1/purchases') {
      const body = JSON.parse(String(init?.body)) as PurchaseRequest
      this.purchases.push(body)
      if (this.purchaseRefusal) {
        const r = this.purchaseRefusal
        this.purchaseRefusal = null
        return Response.json(r.body, { status: r.status })
      }
      this.domains.push({ name: body.name, state: 'charging', error: null, renewsAt: null, autoRenew: true })
      return Response.json({ name: body.name, state: 'charging' }, { status: 202 })
    }
    return Response.json({ error: 'Not found.' }, { status: 404 })
  }

  config() {
    return { apiBase: this.origin, token: this.token }
  }
}
