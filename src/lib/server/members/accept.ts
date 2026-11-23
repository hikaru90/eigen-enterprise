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

/** The name a person gives when they join (the invite page, open join on /signup). */
export const joinNameSchema = z.string().trim().min(1, 'Enter your name.').max(80, 'Keep your name under 80 characters.')

async function openInvite(token: string, deps: Pick<AcceptDeps, 'store' | 'now'>): Promise<Invite> {
  const st = await inviteStatus(token, deps)
  if (!st.ok) throw new InviteError(inviteMessage(st.reason))
  return st.invite
}

function joinName(input: { name: string }): string {
  const name = joinNameSchema.safeParse(input.name)
  if (!name.success) throw new InviteError(name.error.issues[0]!.message)
  return name.data
}

const scopeOf = (invite: Invite) => ({ inviteId: invite.id, email: invite.email, role: invite.role })

export async function joinWithInvite(token: string, input: { name: string }, deps: AcceptDeps): Promise<{ email: string }> {
  const name = joinName(input)
  const invite = await openInvite(token, deps)
  const code = await deps.createCode(invite.email)
  await inviteScope.run(scopeOf(invite), () => deps.signIn(invite.email, code, name))
  return { email: invite.email }
}

export type CreateInvitedAccountDeps = Pick<AcceptDeps, 'store' | 'now'> & {
  /**
   * Create the account through Better Auth's user-create hooks (the same hook
   * the sign-in runs: it takes the invited role and consumes the invite) —
   * without a session or a cookie.
   */
  createAccount: (email: string, name: string) => Promise<unknown>
}

/**
 * Accept an invite on the server where no person is at a browser (the demo
 * seed, modules/demo): the same refusals as joinWithInvite and the same
 * invite scope, but nobody is signed in — a sign-in would hand the new
 * session cookie to whatever request is running (the owner's own), and there
 * is no browser to keep it. The person signs in later with a code like anyone.
 */
export async function createInvitedAccount(
  token: string,
  input: { name: string },
  deps: CreateInvitedAccountDeps,
): Promise<{ email: string }> {
  const name = joinName(input)
  const invite = await openInvite(token, deps)
  await inviteScope.run(scopeOf(invite), () => deps.createAccount(invite.email, name))
  return { email: invite.email }
}
