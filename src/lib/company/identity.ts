/**
 * The company's identity (Contribute `6a3b17ba`): its name and logo, shown at
 * the top left of the app and edited in Settings → Company by the owner and
 * admins. Shared by the server (validation, routes) and the settings page.
 */

/** The authenticated route that serves the current logo by its SHA-256. */
export const COMPANY_LOGO_ROUTE = '/api/company/logo'

export const MAX_COMPANY_NAME_LENGTH = 80

/** What a logo may be. SVGs are sanitized on upload and served with a sandboxing CSP. */
export const LOGO_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp'] as const
export type LogoType = (typeof LOGO_TYPES)[number]

export const MAX_LOGO_BYTES = 1024 * 1024

export const isLogoType = (v: unknown): v is LogoType =>
  typeof v === 'string' && (LOGO_TYPES as readonly string[]).includes(v)

const SHA256 = /^[0-9a-f]{64}$/
export const isLogoSha = (v: unknown): v is string => typeof v === 'string' && SHA256.test(v)

export function companyLogoUrl(sha256: string): string {
  if (!isLogoSha(sha256)) throw new Error(`not a sha256: ${sha256}`)
  return `${COMPANY_LOGO_ROUTE}/${sha256}`
}

export type CompanyNameResult = { ok: true; name: string } | { ok: false; error: string }

// Control characters (C0, DEL, C1) never belong in a name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

export function normalizeCompanyName(raw: unknown): CompanyNameResult {
  if (typeof raw !== 'string') return { ok: false, error: 'The company name is required.' }
  const name = raw.trim().replace(/\s+/g, ' ')
  if (!name) return { ok: false, error: 'The company name is required.' }
  if (name.length > MAX_COMPANY_NAME_LENGTH) {
    return { ok: false, error: `The company name must be ${MAX_COMPANY_NAME_LENGTH} characters or fewer.` }
  }
  if (CONTROL.test(name)) return { ok: false, error: "The company name contains characters that can't be shown." }
  return { ok: true, name }
}
