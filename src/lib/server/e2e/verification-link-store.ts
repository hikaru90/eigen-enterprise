import { dev } from '$app/environment'

/**
 * Dev/e2e only: remembers the most recent Better Auth verification link per email so the
 * Playwright harness can complete email verification without a real inbox. Never populated
 * outside dev — production verification links are only ever delivered by email.
 */
const linksByEmail = new Map<string, string>()

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

export function recordVerificationLink(email: string, url: string): void {
  if (!dev) return
  linksByEmail.set(normalizeEmail(email), url)
}

export function consumeVerificationLink(email: string): string | undefined {
  if (!dev) return undefined
  const key = normalizeEmail(email)
  const url = linksByEmail.get(key)
  if (url) linksByEmail.delete(key)
  return url
}

const codesByEmail = new Map<string, string>()

/** Dev/e2e only: the most recent email sign-in code per address (passwordless login). */
export function recordSignInCode(email: string, otp: string): void {
  if (!dev) return
  codesByEmail.set(normalizeEmail(email), otp)
}

export function consumeSignInCode(email: string): string | undefined {
  if (!dev) return undefined
  const key = normalizeEmail(email)
  const otp = codesByEmail.get(key)
  if (otp) codesByEmail.delete(key)
  return otp
}
