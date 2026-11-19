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

/** A claim link minted by whoever set up this server (`ee bootstrap --claim-hash`): only its SHA-256 reaches the box. */
export const CLAIM_HASH = /^[0-9a-f]{64}$/

export function claimFromHash(hash: string, now: Date = new Date()): { hash: string; expiresAt: string } {
  if (!CLAIM_HASH.test(hash)) throw new Error('--claim-hash must be 64 lowercase hex characters (the SHA-256 of the claim token)')
  return { hash, expiresAt: new Date(now.getTime() + CLAIM_TTL_DAYS * 86_400_000).toISOString() }
}

export function claimUrl(consoleHost: string, token: string): string {
  return `https://${consoleHost}/claim?token=${encodeURIComponent(token)}`
}

/**
 * The owner link (getting back in): once the company has an owner, root on the box can still sign
 * that owner in — `ee owner-link` mints a one-hour, single-use link, and the server keeps only its
 * SHA-256 + expiry. For an owner with no passkey and no company email yet (sign-in codes need email).
 */
export const OWNER_LINK_TTL_MS = 60 * 60_000
/** Declared on os once the first owner link is minted; a bootstrap re-run keeps them (resolveOsSecrets). */
export const OWNER_LINK_SECRETS = ['EE_OWNER_LINK_HASH', 'EE_OWNER_LINK_EXPIRES_AT'] as const

export function newOwnerLink(now: Date = new Date()): { token: string; hash: string; expiresAt: string } {
  const token = randomBytes(24).toString('base64url')
  return {
    token,
    hash: createHash('sha256').update(token).digest('hex'),
    expiresAt: new Date(now.getTime() + OWNER_LINK_TTL_MS).toISOString(),
  }
}

export function ownerLinkUrl(consoleHost: string, token: string): string {
  return `https://${consoleHost}/owner-link?token=${encodeURIComponent(token)}`
}

/** eigenEnterprise answers here (GET, on OS_INTERNAL_PORT): 200 while nobody has claimed it, 409 once an owner exists. */
export const CLAIM_OPEN_PATH = '/api/claim/open'
export const OS_HEALTH_PATH = '/api/health'

/**
 * Whether a new claim link may be minted. The company's database is the only
 * truth about whether an owner exists, so ee asks eigenEnterprise: open → mint;
 * healthy but not open → the company is claimed; neither → can't tell (refuse).
 */
export async function claimState(
  sys: { httpOk(port: number, path: string, timeoutMs: number): Promise<boolean> },
  port: number,
): Promise<'open' | 'claimed' | 'unreachable'> {
  if (await sys.httpOk(port, CLAIM_OPEN_PATH, 3000)) return 'open'
  return (await sys.httpOk(port, OS_HEALTH_PATH, 3000)) ? 'claimed' : 'unreachable'
}
