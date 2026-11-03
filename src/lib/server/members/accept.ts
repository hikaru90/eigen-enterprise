import { z } from 'zod'
import { inviteScope } from '$lib/server/auth/owner-policy'
import { inviteMessage, inviteStatus, type Invite, type MemberStore } from './service'

/**
 * Accepting an invite (/invite?token=…), owner decision W-4: holding the link
 * is the proof — the owner shares it (copied from Settings → Members, or by
 * company mail once mail is set up), exactly like the installer's claim link.
 * Joining creates the account with the invited role and signs the person in
 * at once (a server-minted sign-in code, never sent anywhere); the next step
 * registers a passkey, the way back in from then on. The user-create hook
 * consumes the invite (once) inside inviteScope.
 */
export type AcceptDeps = {
  store: MemberStore
  /** Mint a sign-in code without sending it (Better Auth createVerificationOTP, server-only). */
  createCode: (email: string) => Promise<string>
  /** Sign in with that code; creates the account through the normal hooks. */
  signIn: (email: string, code: string, name: string) => Promise<unknown>
  now?: () => Date
}

export class InviteError extends Error {}

const nameSchema = z.string().trim().min(1, 'Enter your name.').max(80, 'Keep your name under 80 characters.')

async function openInvite(token: string, deps: Pick<AcceptDeps, 'store' | 'now'>): Promise<Invite> {
  const st = await inviteStatus(token, deps)
  if (!st.ok) throw new InviteError(inviteMessage(st.reason))
  return st.invite
}

export async function joinWithInvite(token: string, input: { name: string }, deps: AcceptDeps): Promise<{ email: string }> {
  const name = nameSchema.safeParse(input.name)
  if (!name.success) throw new InviteError(name.error.issues[0]!.message)
  const invite = await openInvite(token, deps)
  const code = await deps.createCode(invite.email)
  await inviteScope.run({ inviteId: invite.id, email: invite.email, role: invite.role }, () => deps.signIn(invite.email, code, name.data))
  return { email: invite.email }
}
