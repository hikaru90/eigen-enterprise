import { createHash, randomBytes } from 'node:crypto'

/**
 * The claim link (first-run handover): ee mints a random token, the server
 * keeps only its SHA-256 + an expiry, and the full link is printed once to
 * whoever installed the server. Holding it makes you the company's owner.
 */
export const CLAIM_TTL_DAYS = 7

export function newClaim(now: Date = new Date()): { token: string; hash: string; expiresAt: string } {
  const token = randomBytes(24).toString('base64url')
  return {
    token,
    hash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(now.getTime() + CLAIM_TTL_DAYS * 86_400_000).toISOString(),
  }
}

export function claimUrl(consoleHost: string, token: string): string {
  return `https://${consoleHost}/claim?token=${encodeURIComponent(token)}`
}
