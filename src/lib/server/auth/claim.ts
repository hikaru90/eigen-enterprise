import { createHash, timingSafeEqual } from 'node:crypto'
import { z } from 'zod'
import { claimScope } from './owner-policy'

/**
 * Claiming a fresh server (the first-run handover). The installer (ee) prints a
 * private link with a random token; only its SHA-256 lives on the server
 * (EE_CLAIM_TOKEN_HASH, with EE_CLAIM_EXPIRES_AT). Whoever opens the link enters
 * an email and becomes the owner, signed in immediately: no email is sent,
 * because holding the link is the proof. Once an owner exists, the link is dead.
 */

export type ClaimConfig = { tokenHash: string; expiresAt: Date }

export type ClaimErrorCode = 'no_claim' | 'already_claimed' | 'invalid_token' | 'expired' | 'invalid_email'

export class ClaimError extends Error {
  constructor(
    readonly code: ClaimErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export function claimConfigFromEnv(env: Record<string, string | undefined>): ClaimConfig | null {
  const tokenHash = env.EE_CLAIM_TOKEN_HASH?.trim()
  const expires = env.EE_CLAIM_EXPIRES_AT?.trim()
  if (!tokenHash && !expires) return null
  if (!tokenHash || !expires) {
    throw new Error('claim link is half-configured: EE_CLAIM_TOKEN_HASH and EE_CLAIM_EXPIRES_AT must both be set (ee sets them)')
  }
  const expiresAt = new Date(expires)
  if (Number.isNaN(expiresAt.getTime())) throw new Error(`EE_CLAIM_EXPIRES_AT is not a date: ${expires}`)
  return { tokenHash, expiresAt }
}

export function checkClaimToken(token: string, cfg: ClaimConfig, now: Date): 'ok' | 'invalid' | 'expired' {
  const actual = Buffer.from(createHash('sha256').update(token).digest('hex'))
  const expected = Buffer.from(cfg.tokenHash)
  if (!token || actual.length !== expected.length || !timingSafeEqual(actual, expected)) return 'invalid'
  return now.getTime() > cfg.expiresAt.getTime() ? 'expired' : 'ok'
}

export type ClaimDeps = {
  config: ClaimConfig | null
  countUsers: () => Promise<number>
  /** Mint a sign-in code without sending it (Better Auth createVerificationOTP, server-only). */
  createCode: (email: string) => Promise<string>
  /** Sign in with that code — creates the account through the normal hooks. */
  signIn: (email: string, code: string) => Promise<unknown>
  now?: () => Date
}

/** Reasons that can be shown to the person holding the link. */
export async function claimStatus(token: string, deps: Pick<ClaimDeps, 'config' | 'countUsers' | 'now'>): Promise<'ok' | ClaimErrorCode> {
  if (!deps.config) return 'no_claim'
  if ((await deps.countUsers()) > 0) return 'already_claimed'
  const t = checkClaimToken(token, deps.config, deps.now?.() ?? new Date())
  return t === 'ok' ? 'ok' : t === 'expired' ? 'expired' : 'invalid_token'
}

const MESSAGES: Record<ClaimErrorCode, string> = {
  no_claim: 'This server has no claim link.',
  already_claimed: 'This company already has an owner. Sign in instead.',
  invalid_token: 'This claim link is not valid. Use the exact link the installer printed.',
  expired: 'This claim link has expired. Ask whoever installed the server to run `ee claim-link` for a new one.',
  invalid_email: 'Enter a valid email address.',
}

export function claimMessage(code: ClaimErrorCode): string {
  return MESSAGES[code]
}

export async function claimCompany(input: { email: string; token: string }, deps: ClaimDeps): Promise<void> {
  const email = z.string().trim().toLowerCase().email().safeParse(input.email)
  if (!email.success) throw new ClaimError('invalid_email', MESSAGES.invalid_email)
  const status = await claimStatus(input.token, deps)
  if (status !== 'ok') throw new ClaimError(status, MESSAGES[status])
  const code = await deps.createCode(email.data)
  await claimScope.run(true, () => deps.signIn(email.data, code))
}
