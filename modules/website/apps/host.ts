/**
 * Per-app host names (plan/phase-substrate.md: domains). Derived from the
 * console host's structure, never guessed:
 * - local box (`*.localhost`, Caddy's local CA): `<app>.<parent of the console>`
 *   → os.ee.localhost gives shop.ee.localhost;
 * - pre-DNS server (`<ip>.sslip.io`): `<app>.<ip>.sslip.io` (sslip resolves any label);
 * - the owner's own domain: null — there is no wildcard we can assume, so the
 *   owner names the app's host.
 */

const SSLIP = /(?:^|\.)((?:\d{1,3}-){3}\d{1,3}\.sslip\.io)$/

export function appHost(consoleHost: string, app: string): string | null {
  const host = consoleHost.toLowerCase()
  if (host === 'localhost') return `${app}.localhost`
  if (host.endsWith('.localhost')) {
    const parent = host.split('.').slice(1).join('.')
    return `${app}.${parent}`
  }
  const sslip = SSLIP.exec(host)
  if (sslip) return `${app}.${sslip[1]}`
  return null
}

/** A valid ee app name (lowercase letter first, letters/digits/dashes, 2–31) from a repo name. */
export function appSlug(repoName: string): string {
  let s = repoName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!/^[a-z]/.test(s)) s = `app-${s}`
  s = s.slice(0, 31).replace(/-+$/, '')
  return s.length >= 2 ? s : 'app'
}

/** First free variant of base ("shop" → "shop-2" → …) that fits the app-name shape; case-insensitive. */
export function freeName(taken: ReadonlySet<string>, base: string): string {
  const takenLower = new Set([...taken].map((n) => n.toLowerCase()))
  let name = base
  for (let i = 2; takenLower.has(name.toLowerCase()); i++) {
    const suffix = `-${i}`
    name = base.slice(0, 31 - suffix.length) + suffix
  }
  return name
}
