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
