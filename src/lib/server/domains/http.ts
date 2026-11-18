import type { DomainsConfig } from './config'
import { json } from '@sveltejs/kit'
import type { BoughtDomain } from '$lib/domains/contract'
import { roleCan } from '$lib/server/auth/capabilities'
import type { MemberRole } from '$lib/server/auth/roles'
import { DomainsApiError, domainsClient } from './client'

/**
 * os's session routes for buying domains (plan/managed-domains.md DM6): the
 * browser talks to these; only the server holds EE_DOMAINS_TOKEN and calls
 * the control plane. Owner and admins only (the domain is the company's, like
 * its name: `company.manage`). Every answer is what os validated — never the
 * token, never the control plane's raw body.
 *
 *   GET  /api/domains                → { canBuy, domains }
 *   GET  /api/domains/search?q=acme  → { results }
 *   POST /api/domains/purchases      → 202 { name, state }   (400 / 402 with the control plane's words;
 *                                       409 { error, reason: 'taken' | 'price_changed', priceCents })
 */

export type DomainsEvent = {
  locals: App.Locals
  url: URL
  request: Request
}

export type DomainsHttpDeps = {
  role: (userId: string) => Promise<MemberRole | null>
  config: () => DomainsConfig | null
  fetch?: typeof fetch
}

export const DOMAINS_FORBIDDEN = 'Only the owner or an admin manages the company’s domains.'
export const DOMAINS_NOT_HERE =
  'Buying a domain works on servers hosted by eigenEnterprise. Here, use a domain you already have.'

/** Signed in with `company.manage`, or the refusal to send. */
export async function domainsGuard(
  locals: App.Locals,
  role: (userId: string) => Promise<MemberRole | null>,
): Promise<{ userId: string; email: string } | Response> {
  const user = locals.user
  if (!user) return json({ error: 'You must be signed in.' }, { status: 401 })
  if (!roleCan(await role(user.id), 'company.manage')) return json({ error: DOMAINS_FORBIDDEN }, { status: 403 })
  return { userId: user.id, email: user.email }
}

function failure(err: unknown, what: string): Response {
  if (err instanceof DomainsApiError) {
    return json(err.conflict ? { ...err.conflict } : { error: err.message }, { status: err.status })
  }
  console.error(`[domains] ${what} failed`, { error: err instanceof Error ? err.message : String(err) })
  return json({ error: `${what} failed unexpectedly. Try again in a moment.` }, { status: 500 })
}

export function domainsRoutes(deps: DomainsHttpDeps) {
  const client = () => {
    const config = deps.config()
    return config ? domainsClient(config, deps.fetch ?? fetch) : null
  }

  return {
    async list(event: DomainsEvent): Promise<Response> {
      const who = await domainsGuard(event.locals, deps.role)
      if (who instanceof Response) return who
      const c = client()
      if (!c) return json({ canBuy: false, domains: [] satisfies BoughtDomain[] })
      try {
        return json({ canBuy: true, domains: await c.list() })
      } catch (err) {
        return failure(err, 'Listing the domains')
      }
    },

    async search(event: DomainsEvent): Promise<Response> {
      const who = await domainsGuard(event.locals, deps.role)
      if (who instanceof Response) return who
      const c = client()
      if (!c) return json({ error: DOMAINS_NOT_HERE }, { status: 404 })
      try {
        return json({ results: await c.search(event.url.searchParams.get('q') ?? '') })
      } catch (err) {
        return failure(err, 'The search')
      }
    },

    async purchase(event: DomainsEvent): Promise<Response> {
      const who = await domainsGuard(event.locals, deps.role)
      if (who instanceof Response) return who
      const c = client()
      if (!c) return json({ error: DOMAINS_NOT_HERE }, { status: 404 })
      let body: unknown
      try {
        body = await event.request.json()
      } catch {
        return json({ error: 'Request body must be JSON.' }, { status: 400 })
      }
      try {
        const out = await c.purchase(body as never)
        console.info('[domains] purchase started', { name: out.name, state: out.state, by: who.userId })
        return json(out, { status: 202 })
      } catch (err) {
        return failure(err, 'Buying the domain')
      }
    },
  }
}
