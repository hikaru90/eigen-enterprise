import { getDomain } from 'tldts'
import { z } from 'zod'

/**
 * The one hostname rule on the kernel side (plan/domains-one-claim.md D2):
 * hosting, per-app domains, the domains module and the email platform all use
 * it. ee keeps its own copy (`ee/src/spec.ts` HOSTNAME, a separate binary);
 * a spec holds the two patterns equal.
 */
export const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/

/** Lowercase, at least two labels, a letter-first top-level label, no scheme, path or trailing dot. */
export function isHostname(value: string): boolean {
  return HOSTNAME.test(value)
}

/** A typed host name, trimmed and lowercased, then checked. */
export const hostnameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(HOSTNAME, 'a host name like shop.example.com')

/**
 * The domain a company owns for a host (eigenenterprise.app for
 * rtc.one.eigenenterprise.app), from the public suffix list (tldts), private
 * suffixes included (acme.github.io is its own domain). Null for a bare suffix.
 */
export function registrableDomainOf(host: string): string | null {
  return getDomain(host, { allowPrivateDomains: true })
}
