import { AsyncLocalStorage } from 'node:async_hooks'
import type { MemberRole } from './user-role'

/**
 * Single-tenant ownership (phase-0: one company per instance).
 *
 * On a server ee manages (public), the first account is created ONLY through
 * the claim link the installer printed — holding it proves you installed the
 * server — and becomes the owner. After that, accounts are created only by
 * accepting an invite (Settings → Members), with the invited role.
 * Dev and test instances (not under ee) keep open signup: first = owner.
 */
export class AlreadyClaimedError extends Error {
  constructor() {
    super('This company already has an owner.')
  }
}

export function notAMemberMessage(companyName: string | null): string {
  return `You're not a member of ${companyName ?? 'this company'} yet. Ask the owner for an invite.`
}

export class NotAMemberError extends Error {
  constructor(companyName: string | null = null) {
    super(notAMemberMessage(companyName))
  }
}

export class UnclaimedServerError extends Error {
  constructor() {
    super('This server has not been claimed yet. Open the claim link the installer printed to become its owner.')
  }
}

/** Set while the claim flow creates the owner, so the user-create hook can tell it apart from signup. */
export const claimScope = new AsyncLocalStorage<true>()

/** Set while an invite is accepted: the user-create hook consumes the invite and takes its role. */
export const inviteScope = new AsyncLocalStorage<{ inviteId: string; email: string; role: Exclude<MemberRole, 'owner'> }>()

export function ownerPolicyForNewUser(input: {
  existingUsers: number
  managedByEe: boolean
  viaClaim: boolean
  invite: { role: Exclude<MemberRole, 'owner'> } | null
}): { role: MemberRole } {
  if (input.existingUsers === 0) {
    if (input.managedByEe && !input.viaClaim) throw new UnclaimedServerError()
    return { role: 'owner' }
  }
  if (input.viaClaim) throw new AlreadyClaimedError()
  if (input.invite) return { role: input.invite.role }
  if (input.managedByEe) throw new NotAMemberError()
  return { role: 'member' }
}

/**
 * Before a sign-in code is sent: on a claimed ee server only members get one.
 * Returns the message to show instead, or null to send the code.
 */
export function signInGate(input: {
  managedByEe: boolean
  existingUsers: number
  accountExists: boolean
  companyName: string | null
}): string | null {
  if (!input.managedByEe || input.existingUsers === 0 || input.accountExists) return null
  return notAMemberMessage(input.companyName)
}
