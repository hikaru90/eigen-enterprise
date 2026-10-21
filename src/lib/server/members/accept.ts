import { inviteScope } from '$lib/server/auth/owner-policy'
import { inviteMessage, inviteStatus, type Invite, type MemberStore } from './service'

/**
 * Accepting an invite (/invite?token=…): the invited address gets a sign-in
 * code by email; entering it creates the account with the invited role. The
 * user-create hook consumes the invite (once) inside inviteScope.
 */

export type AcceptDeps = {
  store: MemberStore
  /** Email a sign-in code to the address (Better Auth sendVerificationOTP + delivery check). */
  sendCode: (email: string) => Promise<void>
  /** Sign in with the code; creates the account through the normal hooks. */
  signIn: (email: string, code: string) => Promise<unknown>
  now?: () => Date
}

export class InviteError extends Error {}

async function openInvite(token: string, deps: Pick<AcceptDeps, 'store' | 'now'>): Promise<Invite> {
  const st = await inviteStatus(token, deps)
  if (!st.ok) throw new InviteError(inviteMessage(st.reason))
  return st.invite
}

export async function sendInviteCode(token: string, deps: AcceptDeps): Promise<{ email: string }> {
  const invite = await openInvite(token, deps)
  await deps.sendCode(invite.email)
  return { email: invite.email }
}

export async function acceptInvite(token: string, code: string, deps: AcceptDeps): Promise<{ email: string }> {
  const invite = await openInvite(token, deps)
  await inviteScope.run({ inviteId: invite.id, email: invite.email, role: invite.role }, () => deps.signIn(invite.email, code))
  return { email: invite.email }
}
