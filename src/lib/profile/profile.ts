/**
 * Profiles (plan/phase-polish-1.md P-5): every person has a first name, a last
 * name and a profile picture. Shared by the server (gate, API) and the
 * profile editor in the browser.
 */

/** The authenticated route that serves a profile picture by its SHA-256. */
export const AVATAR_ROUTE = '/api/people/avatar'

/** Where a person without a complete profile is sent first. */
export const PROFILE_STEP_PATH = '/welcome/profile'

/** The picture every profile stores: a square WebP of this many pixels. */
export const AVATAR_SIZE = 256

export const MAX_NAME_LENGTH = 50

const SHA256 = /^[0-9a-f]{64}$/

export const isAvatarSha = (v: unknown): v is string => typeof v === 'string' && SHA256.test(v)

export function avatarUrl(sha256: string): string {
  if (!isAvatarSha(sha256)) throw new Error(`not a sha256: ${sha256}`)
  return `${AVATAR_ROUTE}/${sha256}`
}

export type ProfileFields = {
  firstName?: string | null
  lastName?: string | null
  avatarSha256?: string | null
}

/** Complete = first name, last name and a stored picture. */
export function isProfileComplete(u: ProfileFields | null | undefined): boolean {
  if (!u) return false
  return Boolean(u.firstName?.trim()) && Boolean(u.lastName?.trim()) && isAvatarSha(u.avatarSha256)
}

export type NamesResult =
  | { ok: true; firstName: string; lastName: string; name: string }
  | { ok: false; error: string }

// Control characters (C0, DEL, C1) never belong in a name.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/

function cleanName(raw: unknown, label: string): { ok: true; value: string } | { ok: false; error: string } {
  if (typeof raw !== 'string') return { ok: false, error: `${label} is required.` }
  const value = raw.trim().replace(/\s+/g, ' ')
  if (!value) return { ok: false, error: `${label} is required.` }
  if (value.length > MAX_NAME_LENGTH) return { ok: false, error: `${label} must be ${MAX_NAME_LENGTH} characters or fewer.` }
  if (CONTROL.test(value)) return { ok: false, error: `${label} contains characters that can't be shown.` }
  return { ok: true, value }
}

/** Validates both names; the account name is "First Last". */
export function normalizeProfileNames(input: { firstName?: unknown; lastName?: unknown }): NamesResult {
  const first = cleanName(input.firstName, 'First name')
  if (!first.ok) return first
  const last = cleanName(input.lastName, 'Last name')
  if (!last.ok) return last
  return { ok: true, firstName: first.value, lastName: last.value, name: `${first.value} ${last.value}` }
}

/**
 * Where to continue after the profile step: a same-origin path only (never a
 * protocol-relative or absolute URL — no open redirect), never the step itself.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return '/'
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/'
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\\]/.test(raw)) return '/'
  if (raw === PROFILE_STEP_PATH || raw.startsWith(`${PROFILE_STEP_PATH}?`) || raw.startsWith(`${PROFILE_STEP_PATH}/`)) return '/'
  return raw
}

/** Up to two initials for the avatar fallback ("Ada Lovelace" → "AL"). */
export function initialsOf(name: string | null | undefined): string {
  const parts = (name ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  const first = [...parts[0]][0] ?? ''
  const last = parts.length > 1 ? ([...parts[parts.length - 1]][0] ?? '') : ''
  return (first + last).toUpperCase()
}
