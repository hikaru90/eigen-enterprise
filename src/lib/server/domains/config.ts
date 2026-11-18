/**
 * Managed domains (plan/managed-domains.md, DM6 + Contract): a hosted box buys
 * domains through the control plane's domains API with a per-box token. ee sets
 * these os secrets from `desired.domains`; both or none. A partial set fails
 * loud at start. Absent = this box can't buy domains (self-hosted).
 */

export type DomainsConfig = {
  /** The control plane's bare https origin; the API lives under /api/domains/v1/. */
  apiBase: string
  token: string
}

export const DOMAINS_ENV = {
  apiBase: 'EE_DOMAINS_API_BASE',
  token: 'EE_DOMAINS_TOKEN',
} as const satisfies Record<keyof DomainsConfig, string>

/** Both set → the config; none → null (no buying here); one → throws naming the missing one. */
export function readDomainsConfig(env: Record<string, string | undefined>): DomainsConfig | null {
  const apiBase = env[DOMAINS_ENV.apiBase]?.trim() ?? ''
  const token = env[DOMAINS_ENV.token]?.trim() ?? ''
  if (apiBase === '' && token === '') return null
  if (apiBase === '' || token === '') {
    const missing = apiBase === '' ? DOMAINS_ENV.apiBase : DOMAINS_ENV.token
    throw new Error(`Managed domains are only partly configured: ${missing} is not set (both EE_DOMAINS_* or none).`)
  }
  let url: URL
  try {
    url = new URL(apiBase)
  } catch {
    throw new Error(`${DOMAINS_ENV.apiBase} is not a URL: it must be the control plane's https origin, like https://cloud.example.com.`)
  }
  if (url.protocol !== 'https:' || url.origin !== apiBase.replace(/\/+$/, '')) {
    throw new Error(`${DOMAINS_ENV.apiBase} must be a bare https origin (no path), like https://cloud.example.com.`)
  }
  return { apiBase: url.origin, token }
}
