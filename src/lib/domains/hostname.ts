import { getDomain } from 'tldts'
import { z } from 'zod'

/**
 * The one hostname rule on the kernel side (plan/domains-one-claim.md D2):
 * hosting, per-app domains, the domains module and the email platform all use
 * it. ee keeps its own copy (`ee/src/spec.ts` HOSTNAME, a separate binary);
 * a spec holds the two in agreement.
 *
 * The 253-character cap is a length limit, not part of the pattern: the pattern
 * reaches models in every tool schema that takes a host, and grammar-constrained
 * providers (vLLM/xgrammar, e.g. OpenRouter's OpenInference) refuse a whole request
 * whose schema uses a lookahead. See src/lib/kernel/tool-schema-portable.spec.ts.
 */
export const HOSTNAME_MAX_LENGTH = 253

/** The label rule alone; a host also stays within HOSTNAME_MAX_LENGTH. */
export const HOSTNAME = /^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** Lowercase, at least two labels, a letter-first top-level label, no scheme, path or trailing dot, at most 253 characters. */
export function isHostname(value: string): boolean {
  return value.length <= HOSTNAME_MAX_LENGTH && HOSTNAME.test(value)
}

/** A typed host name, trimmed and lowercased, then checked. */
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(HOSTNAME_MAX_LENGTH, 'a host name is at most 253 characters')
  .regex(HOSTNAME, 'a host name like shop.example.com')

/**
 * The domain a company owns for a host (eigenenterprise.app for
 * rtc.one.eigenenterprise.app), from the public suffix list (tldts), private
 * suffixes included (acme.github.io is its own domain). Null for a bare suffix.
 */
export function registrableDomainOf(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true })
}
