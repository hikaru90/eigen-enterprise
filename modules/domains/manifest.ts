import type { ModuleManifest } from '$lib/kernel/modules'

export const DOMAINS_MODULE_ID = 'domains'

export const DOMAINS_TOOL_NAMES = [
  'domains.list',
  'domains.set_target',
  'domains.remove',
  'domains.recheck',
  'domains.retry_certificate',
] as const

/**
 * Domains (plan/domains-one-claim.md D2): the company's domains, what each
 * hostname shows on the company's server (the console, the company website,
 * an app, calls or nothing), the DNS records each needs with what live DNS
 * says, and each host's certificate. It composes the stores that run things
 * (ee's routes and settings, mail domains, bought domains) — no copy of its
 * own. A core module (a global setting, Settings › Domains): changes to
 * hosting are a human's own act (D11, requireHuman), like `substrate.*`.
 */
export const domainsManifest: ModuleManifest = {
  id: DOMAINS_MODULE_ID,
  name: 'Domains',
  internal: true,
  version: '0.1.0',
  description:
    'The company’s domains: what each address shows, the DNS records it needs, its certificate.',
  tools: [...DOMAINS_TOOL_NAMES],
  permissions: { roles: ['admin', 'agent'] },
}
