import type { DomainsConfig } from './config'
import type { z } from 'zod'
import {
  domainsResponseSchema,
  purchaseConflictSchema,
  purchaseRequestSchema,
  purchaseResponseSchema,
  searchResponseSchema,
  SEARCH_LABEL,
  type BoughtDomain,
  type DomainSearchResult,
  type PurchaseConflict,
  type PurchaseRequest,
  type PurchaseResponse,
} from '$lib/domains/contract'

/**
 * os's client for the control plane's domains API (plan/managed-domains.md,
 * DM6 + Contract). Bearer the per-box token, JSON both ways, every answer
 * validated. Errors are DomainsApiError in plain words: 400/402/409 keep the
 * control plane's status and words (the person can act on them; a 409 also
 * carries its reason and the current price); everything
 * else is a 502 naming what went wrong. The token never appears in an error.
 */

export class DomainsApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** A refused purchase (409): why, and the current price when it changed. */
    readonly conflict: PurchaseConflict | null = null,
  ) {
    super(message)
    this.name = 'DomainsApiError'
  }
}

/** Statuses the person can act on: invalid input, no payment method (409 is read as a conflict). */
const PASS_THROUGH = new Set([400, 402])

export type DomainsClient = {
  search(q: string): Promise<DomainSearchResult[]>
  purchase(input: PurchaseRequest): Promise<PurchaseResponse>
  list(): Promise<BoughtDomain[]>
}

export function domainsClient(config: DomainsConfig, fetchImpl: typeof fetch = fetch): DomainsClient {
  async function call<T>(path: string, schema: z.ZodType<T>, init: { method: 'GET' | 'POST'; body?: unknown }): Promise<T> {
    let res: Response
    try {
      res = await fetchImpl(`${config.apiBase}/api/domains/v1${path}`, {
        method: init.method,
        headers: {
          authorization: `Bearer ${config.token}`,
          accept: 'application/json',
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      })
    } catch (err) {
      throw new DomainsApiError(
        502,
        `Could not reach the eigenEnterprise domain service (${err instanceof Error ? err.message : String(err)}). Try again in a moment.`,
      )
    }
    const body = (await res.json().catch(() => null)) as unknown
    if (!res.ok) {
      const said = typeof (body as { error?: unknown } | null)?.error === 'string' ? (body as { error: string }).error : null
      if (res.status === 409) {
        // The reason is a field, never read from the words.
        const conflict = purchaseConflictSchema.safeParse(body)
        if (!conflict.success) {
          throw new DomainsApiError(502, 'The eigenEnterprise domain service refused the purchase without saying why. Contact support.')
        }
        throw new DomainsApiError(409, conflict.data.error, conflict.data)
      }
      if (PASS_THROUGH.has(res.status) && said) throw new DomainsApiError(res.status, said)
      if (res.status === 401 || res.status === 403) {
        throw new DomainsApiError(502, 'The eigenEnterprise domain service did not accept this server’s token. Contact support.')
      }
      throw new DomainsApiError(
        502,
        `The eigenEnterprise domain service failed (HTTP ${res.status}${said ? `: ${said}` : ''}). Try again in a moment.`,
      )
    }
    const parsed = schema.safeParse(body)
    if (!parsed.success) {
      throw new DomainsApiError(502, 'The eigenEnterprise domain service sent an unexpected answer. Contact support.')
    }
    return parsed.data
  }

  return {
    async search(q) {
      const label = q.trim().toLowerCase()
      if (label.includes('.')) {
        throw new DomainsApiError(400, 'Type just the name, without the ending (.com, .eu …) — like acme.')
      }
      if (!SEARCH_LABEL.test(label)) {
        throw new DomainsApiError(400, 'Use letters, digits and hyphens only, up to 63 characters — like acme or acme-studio.')
      }
      return (await call(`/search?q=${encodeURIComponent(label)}`, searchResponseSchema, { method: 'GET' })).results
    },
    async purchase(input) {
      const parsed = purchaseRequestSchema.safeParse(input)
      if (!parsed.success) throw new DomainsApiError(400, parsed.error.issues[0]?.message ?? 'The purchase is incomplete.')
      return call('/purchases', purchaseResponseSchema, { method: 'POST', body: parsed.data })
    },
    async list() {
      return (await call('/domains', domainsResponseSchema, { method: 'GET' })).domains
    },
  }
}
