import { checkClaimToken, claimConfigFromEnv, claimTokenHash, type ClaimConfig } from './claim'

/**
 * Back in as the owner: `ee owner-link` (root on the box) mints a one-hour, single-use link; only
 * its SHA-256 + expiry reach os (EE_OWNER_LINK_HASH / EE_OWNER_LINK_EXPIRES_AT). Holding it signs
 * the company's owner in — no email is sent, because root on the box is the proof. It exists for
 * an owner without a passkey while company email (sign-in codes) isn't set up.
 */

export type OwnerLinkStatus = 'ok' | 'no_link' | 'invalid_token' | 'expired' | 'used' | 'no_owner'

export class OwnerLinkError extends Error {
  constructor(
    readonly code: Exclude<OwnerLinkStatus, 'ok'>,
    message: string,
  ) {
    super(message)
  }
}

export function ownerLinkConfigFromEnv(env: Record<string, string | undefined>): ClaimConfig | null {
  const mapped = { EE_CLAIM_TOKEN_HASH: env.EE_OWNER_LINK_HASH, EE_CLAIM_EXPIRES_AT: env.EE_OWNER_LINK_EXPIRES_AT }
  try {
    return claimConfigFromEnv(mapped)
  } catch (err) {
    throw new Error(`owner link: ${(err as Error).message.replace(/EE_CLAIM_TOKEN_HASH/g, 'EE_OWNER_LINK_HASH').replace(/EE_CLAIM_EXPIRES_AT/g, 'EE_OWNER_LINK_EXPIRES_AT')}`, { cause: err })
  }
}

export type OwnerLinkDeps = {
  config: ClaimConfig | null
  /** The owner's email (the earliest owner account), or null when there is none. */
  ownerEmail: () => Promise<string | null>
  isConsumed: (tokenHash: string) => Promise<boolean>
  /** Record the token (by hash) as used; false when another request used it first (atomic). */
  consume: (tokenHash: string) => Promise<boolean>
  createCode: (email: string) => Promise<string>
  signIn: (email: string, code: string) => Promise<unknown>
  now?: () => Date
}

const MESSAGES: Record<Exclude<OwnerLinkStatus, 'ok'>, string> = {
  no_link: 'This server has no owner sign-in link. Root on the server runs `ee owner-link` to make one.',
  invalid_token: 'This owner sign-in link is not valid. Use the exact link `ee owner-link` printed.',
  expired: 'This owner sign-in link has expired (they last one hour). Run `ee owner-link` on the server for a new one.',
  used: 'This owner sign-in link was already used. Run `ee owner-link` on the server for a new one.',
  no_owner: 'This company has no owner yet. Claim it with the link from `ee claim-link`.',
}

export function ownerLinkMessage(code: Exclude<OwnerLinkStatus, 'ok'>): string {
  return MESSAGES[code]
}

export async function ownerLinkStatus(
  token: string,
  deps: Pick<OwnerLinkDeps, 'config' | 'ownerEmail' | 'isConsumed' | 'now'>,
): Promise<OwnerLinkStatus> {
  if (!deps.config) return 'no_link'
  const t = checkClaimToken(token, deps.config, deps.now?.() ?? new Date())
  if (t === 'invalid') return 'invalid_token'
  if (await deps.isConsumed(claimTokenHash(token))) return 'used'
  if (t === 'expired') return 'expired'
  return (await deps.ownerEmail()) ? 'ok' : 'no_owner'
}

/** Signs the owner in with the link; returns their email. The token is spent before the sign-in. */
export async function signInWithOwnerLink(token: string, deps: OwnerLinkDeps): Promise<string> {
  const status = await ownerLinkStatus(token, deps)
  if (status !== 'ok') throw new OwnerLinkError(status, MESSAGES[status])
  const email = await deps.ownerEmail()
  if (!email) throw new OwnerLinkError('no_owner', MESSAGES.no_owner)
  if (!(await deps.consume(claimTokenHash(token)))) throw new OwnerLinkError('used', MESSAGES.used)
  await deps.signIn(email, await deps.createCode(email))
  return email
}
